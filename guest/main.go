// Command x402-guest is the trusted session supervisor. It runs inside the
// sandbox pod, generates an ephemeral key pair, attests to it, and then serves
// encrypted execution and filesystem operations for the lifetime of the lease.
//
// Security posture (see docs/security-guarantees.md):
//   - the supervisor is non-dumpable (PR_SET_DUMPABLE=0), so same-UID children
//     cannot ptrace it or read its memory through /proc,
//   - the relay token and dev attestation key are read from a 0400 file and
//     dropped after use; they never appear in the process environment,
//   - children never inherit the guest environment,
//   - every child runs in its own process group and is killed at command end,
//   - all filesystem operations are confined to /workspace.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/x402s/sandbox/guest/internal/attest"
	"github.com/x402s/sandbox/guest/internal/envelope"
	"github.com/x402s/sandbox/guest/internal/files"
	"github.com/x402s/sandbox/guest/internal/hardening"
	"github.com/x402s/sandbox/guest/internal/protocol"
	"github.com/x402s/sandbox/guest/internal/relay"
	"github.com/x402s/sandbox/guest/internal/runner"
)

const defaultWorkspace = "/workspace"

func main() {
	cmd := "run"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	switch cmd {
	case "run":
		if err := run(); err != nil {
			logEvent("guest_failed", map[string]any{"error": err.Error()})
			os.Exit(1)
		}
	case "bootstrap":
		if err := bootstrap(); err != nil {
			logEvent("bootstrap_failed", map[string]any{"error": err.Error()})
			os.Exit(1)
		}
	case "version":
		fmt.Println("x402-guest 0.2.0")
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", cmd)
		os.Exit(2)
	}
}

func run() error {
	if strings.EqualFold(getEnv("WARM_MODE", "false"), "true") {
		return runWarm()
	}
	return runSession(configFromEnv())
}

// sessionConfig is everything that differs between a cold-started session and
// a session handed to a pre-booted warm pod.
type sessionConfig struct {
	SessionID         string
	RelayURL          string
	GuestToken        string
	ClientPublicKey   string
	ClientNonce       string
	LeaseSeconds      int64
	ExecutionMode     string
	RuntimeClass      string
	ImageDigest       string
	DevKey            string
	DevKeyID          string
	ProxyURL          string
	ProxyToken        string
	MaxOutput         int
	MaxFileBytes      int64
	MaxDiskMiB        int64
	MaxCommandSeconds int
	MaxProcesses      int
	WorkspaceDir      string
	Tools             string
}

func configFromEnv() sessionConfig {
	sessionID := requireEnv("SESSION_ID")
	relayURL := requireEnv("RELAY_URL")
	token, devKey, devKeyID, bootProxyToken := loadBootstrap()
	proxyToken := os.Getenv("PROXY_TOKEN")
	if bootProxyToken != "" {
		proxyToken = bootProxyToken
	}
	return sessionConfig{
		SessionID:         sessionID,
		RelayURL:          withToken(relayURL, token),
		GuestToken:        token,
		ClientPublicKey:   requireEnv("CLIENT_PUBLIC_KEY"),
		ClientNonce:       requireEnv("CLIENT_NONCE"),
		LeaseSeconds:      int64(parseIntEnv("LEASE_SECONDS", 300)),
		ExecutionMode:     getEnv("EXECUTION_MODE", "dev"),
		RuntimeClass:      os.Getenv("RUNTIME_CLASS"),
		ImageDigest:       os.Getenv("GUEST_IMAGE_DIGEST"),
		DevKey:            devKey,
		DevKeyID:          devKeyID,
		ProxyURL:          os.Getenv("EGRESS_PROXY_URL"),
		ProxyToken:        proxyToken,
		MaxOutput:         parseIntEnv("MAX_OUTPUT_BYTES", 262144),
		MaxFileBytes:      int64(parseIntEnv("MAX_FILE_BYTES", 8*1024*1024)),
		MaxDiskMiB:        int64(parseIntEnv("MAX_DISK_MIB", 256)),
		MaxCommandSeconds: parseIntEnv("MAX_COMMAND_SECONDS", 300),
		MaxProcesses:      parseIntEnv("MAX_PROCESSES", 256),
		WorkspaceDir:      getEnv("WORKSPACE_DIR", defaultWorkspace),
		Tools:             getEnv("GUEST_TOOLS", "python3,node,bash,tar,curl,git"),
	}
}

func runSession(cfg sessionConfig) error {
	// The supervisor must not be dumpable by same-UID processes (blocks ptrace
	// and /proc/<pid>/mem reads from customer code in dev mode), and the process
	// count for the shared UID is capped as defence in depth on top of the
	// pod-level pod-max-pids.
	if err := hardening.Configure(cfg.MaxProcesses); err != nil {
		return fmt.Errorf("could not apply process hardening: %w", err)
	}

	if err := os.MkdirAll(cfg.WorkspaceDir, 0o755); err != nil {
		return fmt.Errorf("prepare workspace: %w", err)
	}
	ws, err := files.New(cfg.WorkspaceDir, cfg.MaxFileBytes, cfg.MaxDiskMiB*1024*1024)
	if err != nil {
		return fmt.Errorf("prepare workspace: %w", err)
	}

	clientKey, err := envelope.PublicKeyFromBase64(cfg.ClientPublicKey)
	if err != nil {
		return fmt.Errorf("client public key: %w", err)
	}
	keyPair, err := envelope.GenerateKeyPair()
	if err != nil {
		return fmt.Errorf("ephemeral key: %w", err)
	}

	evidence, err := attest.BuildEvidence(attest.Config{
		SessionID:       cfg.SessionID,
		ClientPublicKey: cfg.ClientPublicKey,
		ClientNonce:     cfg.ClientNonce,
		GuestPublicKey:  keyPair.PublicBase64(),
		ExecutionMode:   cfg.ExecutionMode,
		RuntimeClass:    cfg.RuntimeClass,
		ImageDigest:     cfg.ImageDigest,
		DevKeyID:        cfg.DevKeyID,
		DevKeySeedB64:   cfg.DevKey,
		Tools:           strings.Split(cfg.Tools, ","),
		LeaseSeconds:    cfg.LeaseSeconds,
	})
	if err != nil {
		return fmt.Errorf("attestation: %w", err)
	}
	// The signing key is only needed for the evidence above.
	cfg.DevKey = ""
	cfg.GuestToken = ""

	logEvent("guest_started", map[string]any{
		"sessionId":     cfg.SessionID,
		"executionMode": cfg.ExecutionMode,
		"leaseSeconds":  cfg.LeaseSeconds,
		"kernelRelease": attest.KernelRelease(),
		"resumed":       getEnv("RESUME", "") == "1",
	})
	if getEnv("RESUME", "") == "1" {
		// The workspace is a persistent volume; the guest is a fresh process
		// with a fresh keypair, exactly like a Lambda MicroVM resume hook.
		logEvent("guest_resumed", map[string]any{"sessionId": cfg.SessionID})
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	client, err := relay.Dial(ctx, cfg.RelayURL, 60*time.Second)
	if err != nil {
		return err
	}
	defer client.Close()
	if err := client.SendHello(ctx, evidence); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}
	logEvent("guest_hello_sent", map[string]any{"sessionId": cfg.SessionID})

	sup := &supervisor{
		conn:        client,
		keys:        keyPair,
		clientKey:   clientKey,
		sessionID:   cfg.SessionID,
		clientNonce: cfg.ClientNonce,
		workspace:   ws,
		runner: runner.Options{
			Workspace:  cfg.WorkspaceDir,
			ProxyURL:   cfg.ProxyURL,
			ProxyToken: cfg.ProxyToken,
			MaxOutput:  cfg.MaxOutput,
			MaxCommand: time.Duration(cfg.MaxCommandSeconds) * time.Second,
		},
		// The guest's own lease view starts at hello; the controller enforces the
		// authoritative deadline independently and shuts the supervisor down.
		lease:    time.Now().Add(time.Duration(cfg.LeaseSeconds)*time.Second + 2*time.Second),
		inflight: map[string]context.CancelFunc{},
		slots:    make(chan struct{}, 1),
		maxFile:  cfg.MaxFileBytes,
	}
	logEvent("guest_ready", map[string]any{"sessionId": cfg.SessionID, "leaseDeadline": sup.lease.UTC().Format(time.RFC3339)})
	return sup.serve(ctx)
}

// runWarm boots the guest without a session. It connects to a pooled relay
// entry, announces readiness, and waits for the controller's claim. Nothing
// customer-specific exists in the pod before that frame arrives.
func runWarm() error {
	poolID := requireEnv("POOL_ID")
	relayURL := requireEnv("RELAY_URL")
	token, devKey, devKeyID, _ := loadBootstrap()
	relayURL = withToken(relayURL, token)

	if err := hardening.Configure(parseIntEnv("MAX_PROCESSES", 256)); err != nil {
		return fmt.Errorf("could not apply process hardening: %w", err)
	}
	workspaceDir := getEnv("WORKSPACE_DIR", defaultWorkspace)
	if err := os.MkdirAll(workspaceDir, 0o755); err != nil {
		return fmt.Errorf("prepare workspace: %w", err)
	}
	// Validate the volume before a claim so a broken mount fails here, not
	// after the customer has paid.
	if _, err := files.New(workspaceDir,
		int64(parseIntEnv("MAX_FILE_BYTES", 8*1024*1024)),
		int64(parseIntEnv("MAX_DISK_MIB", 256))*1024*1024,
	); err != nil {
		return fmt.Errorf("prepare workspace: %w", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	client, err := relay.Dial(ctx, relayURL, 60*time.Second)
	if err != nil {
		return err
	}
	defer client.Close()

	// Readiness signal only. This is never presented as session evidence: it
	// has no session binding and the real hello (fresh key, customer nonce) is
	// sent after the claim.
	if err := client.SendHello(ctx, map[string]any{
		"v":               1,
		"evidenceType":    "warm-pool",
		"insecureDevOnly": true,
		"hardwareBacked":  false,
		"sessionId":       poolID,
		"guestPublicKey":  "",
		"clientPublicKey": "",
		"clientNonce":     "",
		"bootNonce":       "",
		"issuedAt":        time.Now().UnixMilli(),
		"expiresAt":       0,
		"report":          "",
		"claims":          map[string]any{},
		"signature":       map[string]any{},
	}); err != nil {
		return fmt.Errorf("send warm hello: %w", err)
	}
	logEvent("guest_warm_ready", map[string]any{"poolId": poolID})

	ttl := parseIntEnv("WARM_TTL_SECONDS", 600)
	deadline := time.Now().Add(time.Duration(ttl) * time.Second)
	for {
		readCtx, cancel := context.WithDeadline(ctx, deadline)
		frame, err := client.Read(readCtx)
		cancel()
		if err != nil {
			return err
		}
		switch frame.Type {
		case "claim":
			if frame.Claim == nil {
				continue
			}
			claim := frame.Claim
			logEvent("guest_warm_claimed", map[string]any{"poolId": poolID, "sessionId": claim.SessionID})
			client.Close()
			return runSession(sessionConfig{
				SessionID:         claim.SessionID,
				RelayURL:          withToken(claim.RelayURL, claim.GuestToken),
				GuestToken:        claim.GuestToken,
				ClientPublicKey:   claim.ClientPublicKey,
				ClientNonce:       claim.ClientNonce,
				LeaseSeconds:      claim.LeaseSeconds,
				ExecutionMode:     claim.ExecutionMode,
				RuntimeClass:      claim.RuntimeClass,
				ImageDigest:       claim.ImageDigest,
				DevKey:            devKey,
				DevKeyID:          devKeyID,
				ProxyURL:          claim.ProxyURL,
				ProxyToken:        claim.ProxyToken,
				MaxOutput:         claim.MaxOutputBytes,
				MaxFileBytes:      claim.MaxFileBytes,
				MaxDiskMiB:        claim.MaxDiskMiB,
				MaxCommandSeconds: claim.MaxCommandSeconds,
				MaxProcesses:      claim.MaxProcesses,
				WorkspaceDir:      workspaceDir,
				Tools:             claim.Tools,
			})
		case "shutdown":
			logEvent("guest_warm_shutdown", map[string]any{"poolId": poolID, "reason": frame.Reason})
			return nil
		default:
			logEvent("guest_warm_unknown_frame", map[string]any{"type": frame.Type})
		}
	}
}

func withToken(relayURL, token string) string {
	if token == "" {
		return relayURL
	}
	separator := "?"
	if strings.Contains(relayURL, "?") {
		separator = "&"
	}
	return relayURL + separator + "token=" + url.QueryEscape(token)
}

type supervisor struct {
	conn        *relay.Client
	keys        *envelope.KeyPair
	clientKey   *[32]byte
	sessionID   string
	clientNonce string
	workspace   *files.Workspace
	runner      runner.Options
	lease       time.Time
	maxFile     int64

	mu       sync.Mutex
	inflight map[string]context.CancelFunc
	slots    chan struct{}
}

func (s *supervisor) serve(ctx context.Context) error {
	for {
		readCtx, cancel := context.WithDeadline(ctx, s.lease)
		frame, err := s.conn.Read(readCtx)
		expired := readCtx.Err() != nil
		cancel()
		if err != nil {
			s.shutdownAll()
			if expired || errors.Is(ctx.Err(), context.Canceled) {
				logEvent("guest_lease_ended", map[string]any{"sessionId": s.sessionID})
				return nil
			}
			return fmt.Errorf("relay read: %w", err)
		}
		switch frame.Type {
		case "request":
			if frame.ID == "" || frame.Envelope == "" {
				continue
			}
			go s.handleRequest(ctx, frame)
		case "cancel":
			s.cancel(frame.ID)
		case "shutdown":
			logEvent("guest_shutdown_requested", map[string]any{"sessionId": s.sessionID, "reason": frame.Reason})
			s.shutdownAll()
			return nil
		default:
			logEvent("guest_unknown_frame", map[string]any{"type": frame.Type})
		}
	}
}

func (s *supervisor) cancel(id string) {
	s.mu.Lock()
	cancel := s.inflight[id]
	s.mu.Unlock()
	if cancel != nil {
		cancel()
		logEvent("guest_cancel", map[string]any{"requestId": id})
	}
}

func (s *supervisor) shutdownAll() {
	s.mu.Lock()
	fns := make([]context.CancelFunc, 0, len(s.inflight))
	for _, fn := range s.inflight {
		fns = append(fns, fn)
	}
	s.mu.Unlock()
	for _, fn := range fns {
		fn()
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		n := len(s.inflight)
		s.mu.Unlock()
		if n == 0 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// handleRequest decrypts, validates, dispatches and answers one operation.
func (s *supervisor) handleRequest(ctx context.Context, frame *relay.Frame) {
	// One operation at a time per session. The controller also enforces this;
	// the guest does so again so a buggy/compromised client cannot race.
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	case <-ctx.Done():
		return
	case <-time.After(10 * time.Second):
		s.replyPlain(ctx, frame.ID, protocol.ErrorResult(&protocol.Request{
			V: 2, SessionID: s.sessionID, ClientNonce: s.clientNonce, RequestID: frame.ID, Op: "exec",
		}, "busy", "another operation is still running"))
		return
	}

	opCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	s.mu.Lock()
	s.inflight[frame.ID] = cancel
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.inflight, frame.ID)
		s.mu.Unlock()
	}()

	req, err := s.decrypt(frame)
	if err != nil {
		s.replyPlain(ctx, frame.ID, protocol.ErrorResult(&protocol.Request{
			V: 2, SessionID: s.sessionID, ClientNonce: s.clientNonce, RequestID: frame.ID, Op: "exec",
		}, "invalid_request", err.Error()))
		return
	}

	// Never let an operation outlive the lease.
	if !s.lease.After(time.Now()) {
		s.reply(ctx, req, protocol.ErrorResult(req, "lease_expired", "the session lease has ended"))
		return
	}

	var result *protocol.Result
	switch req.Op {
	case protocol.OpExec:
		result = s.exec(opCtx, req, frame.DeadlineMs)
	case protocol.OpFilePut:
		result = s.put(req)
	case protocol.OpFileGet:
		result = s.get(req)
	case protocol.OpFileList:
		result = s.list(req)
	case protocol.OpFileStat:
		result = s.stat(req)
	default:
		result = protocol.ErrorResult(req, "unsupported_operation", "unknown operation")
	}
	s.reply(ctx, req, result)
}

func (s *supervisor) decrypt(frame *relay.Frame) (*protocol.Request, error) {
	plain, err := s.keys.Open(frame.Envelope)
	if err != nil {
		return nil, errors.New("payload could not be decrypted")
	}
	defer func() {
		for i := range plain {
			plain[i] = 0
		}
	}()
	var req protocol.Request
	if err := json.Unmarshal(plain, &req); err != nil {
		return nil, errors.New("payload is not a valid operation")
	}
	if req.V != 2 || req.SessionID != s.sessionID || req.ClientNonce != s.clientNonce || req.RequestID != frame.ID {
		return nil, errors.New("operation is bound to a different session")
	}
	if req.RequestID == "" || len(req.RequestID) > 128 {
		return nil, errors.New("invalid request id")
	}
	return &req, nil
}

func (s *supervisor) exec(ctx context.Context, req *protocol.Request, deadlineMs int64) *protocol.Result {
	timeout := time.Duration(req.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	if remaining := time.Until(s.lease); remaining < timeout {
		timeout = remaining
	}
	// The controller's per-request deadline is authoritative and may be shorter
	// than the guest's own lease view.
	if deadlineMs > 0 {
		if d := time.Until(time.UnixMilli(deadlineMs)); d < timeout {
			timeout = d
		}
	}
	cwd := s.runner.Workspace
	if req.Cwd != "" {
		abs, err := s.workspace.Resolve(req.Cwd)
		if err != nil {
			return protocol.ErrorResult(req, "invalid_cwd", "working directory is outside the workspace")
		}
		info, err := os.Stat(abs)
		if err != nil || !info.IsDir() {
			return protocol.ErrorResult(req, "invalid_cwd", "working directory does not exist")
		}
		cwd = abs
	}
	return runner.Execute(ctx, s.runner, req, cwd, timeout)
}

func (s *supervisor) put(req *protocol.Request) *protocol.Result {
	if req.Path == "" {
		return protocol.ErrorResult(req, "invalid_path", "path is required")
	}
	data, err := base64.StdEncoding.DecodeString(req.DataBase64)
	if err != nil {
		return protocol.ErrorResult(req, "invalid_payload", "payload is not valid base64")
	}
	if int64(len(data)) > s.maxFile {
		return protocol.ErrorResult(req, "file_too_large", "payload exceeds the configured limit")
	}
	written, count, err := s.workspace.Put(req.Path, data, os.FileMode(req.Mode), req.Archive)
	if err != nil {
		return fileError(req, err)
	}
	return &protocol.Result{
		V: 2, SessionID: s.sessionID, ClientNonce: s.clientNonce, RequestID: req.RequestID,
		Op: protocol.OpFilePut, OK: true, Path: req.Path, BytesWritten: written, FilesWritten: count,
	}
}

func (s *supervisor) get(req *protocol.Request) *protocol.Result {
	data, err := s.workspace.Get(req.Path, req.Archive)
	if err != nil {
		return fileError(req, err)
	}
	if int64(len(data)) > s.maxFile {
		return protocol.ErrorResult(req, "file_too_large", "file exceeds the configured limit; request an archive of a subdirectory")
	}
	return &protocol.Result{
		V: 2, SessionID: s.sessionID, ClientNonce: s.clientNonce, RequestID: req.RequestID,
		Op: protocol.OpFileGet, OK: true, Path: req.Path,
		DataBase64: base64.StdEncoding.EncodeToString(data), Size: int64(len(data)), Archive: req.Archive,
	}
}

func (s *supervisor) list(req *protocol.Request) *protocol.Result {
	entries, total, err := s.workspace.List(req.Path, req.Recursive)
	if err != nil {
		return fileError(req, err)
	}
	return &protocol.Result{
		V: 2, SessionID: s.sessionID, ClientNonce: s.clientNonce, RequestID: req.RequestID,
		Op: protocol.OpFileList, OK: true, Path: req.Path, Entries: entries, TotalBytes: total,
	}
}

func (s *supervisor) stat(req *protocol.Request) *protocol.Result {
	entry, err := s.workspace.Stat(req.Path)
	if err != nil {
		return fileError(req, err)
	}
	return &protocol.Result{
		V: 2, SessionID: s.sessionID, ClientNonce: s.clientNonce, RequestID: req.RequestID,
		Op: protocol.OpFileStat, OK: true, Path: req.Path, Entry: entry,
	}
}

func fileError(req *protocol.Request, err error) *protocol.Result {
	var fe *files.Error
	if errors.As(err, &fe) {
		return protocol.ErrorResult(req, fe.Code, fe.Message)
	}
	return protocol.ErrorResult(req, "io_error", "filesystem operation failed")
}

func (s *supervisor) reply(ctx context.Context, req *protocol.Request, result *protocol.Result) {
	plain, err := json.Marshal(result)
	if err != nil {
		s.replyPlain(ctx, req.RequestID, protocol.ErrorResult(req, "encoding_failed", "could not encode result"))
		return
	}
	sealed, err := envelope.Seal(s.clientKey, plain)
	for i := range plain {
		plain[i] = 0
	}
	if err != nil {
		s.replyPlain(ctx, req.RequestID, protocol.ErrorResult(req, "encryption_failed", "could not encrypt result"))
		return
	}
	if err := s.conn.SendResponse(ctx, req.RequestID, sealed); err != nil {
		logEvent("guest_reply_failed", map[string]any{"requestId": req.RequestID})
		return
	}
	fields := map[string]any{"requestId": req.RequestID, "op": req.Op, "ok": result.OK}
	if result.Op == protocol.OpExec {
		fields["exitCode"] = result.ExitCode
		fields["durationMs"] = result.DurationMs
		fields["stdoutLen"] = len(result.Stdout)
		fields["stderrLen"] = len(result.Stderr)
		fields["timedOut"] = result.TimedOut
		fields["cancelled"] = result.Cancelled
	}
	if result.Error != nil {
		fields["errorCode"] = result.Error.Code
	}
	logEvent("guest_operation", fields)
}

// replyPlain reports an error the client can decrypt (used when the request
// itself could not be parsed).
func (s *supervisor) replyPlain(ctx context.Context, id string, result *protocol.Result) {
	plain, err := json.Marshal(result)
	if err != nil {
		return
	}
	sealed, err := envelope.Seal(s.clientKey, plain)
	if err != nil {
		return
	}
	_ = s.conn.SendResponse(ctx, id, sealed)
}

// bootstrap writes credentials to a mode-0400 file for the main container.
func bootstrap() error {
	dir := sandboxDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	payload := map[string]string{
		"guestToken":          os.Getenv("GUEST_TOKEN"),
		"devAttestationKey":   os.Getenv("DEV_ATTESTATION_KEY"),
		"devAttestationKeyId": os.Getenv("DEV_ATTESTATION_KEY_ID"),
		"proxyToken":          os.Getenv("PROXY_TOKEN"),
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "bootstrap.json"), data, 0o400)
}

func loadBootstrap() (token, devKey, devKeyID, proxyToken string) {
	path := filepath.Join(sandboxDir(), "bootstrap.json")
	data, err := os.ReadFile(path)
	if err == nil {
		var payload struct {
			GuestToken          string `json:"guestToken"`
			DevAttestationKey   string `json:"devAttestationKey"`
			DevAttestationKeyId string `json:"devAttestationKeyId"`
			ProxyToken          string `json:"proxyToken"`
		}
		if json.Unmarshal(data, &payload) == nil {
			_ = os.Remove(path)
			return payload.GuestToken, payload.DevAttestationKey, payload.DevAttestationKeyId, payload.ProxyToken
		}
	}
	return os.Getenv("GUEST_TOKEN"), os.Getenv("DEV_ATTESTATION_KEY"), os.Getenv("DEV_ATTESTATION_KEY_ID"), os.Getenv("PROXY_TOKEN")
}

func requireEnv(name string) string {
	v := os.Getenv(name)
	if v == "" {
		logEvent("config_error", map[string]any{"missing": name})
		os.Exit(1)
	}
	return v
}

func getEnv(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func sandboxDir() string {
	if v := os.Getenv("X402_SANDBOX_DIR"); v != "" {
		return v
	}
	return "/run/x402"
}

func parseIntEnv(name string, def int) int {
	v := os.Getenv(name)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return def
	}
	return n
}

func logEvent(event string, fields map[string]any) {
	line := map[string]any{
		"ts":      time.Now().UTC().Format(time.RFC3339Nano),
		"level":   "info",
		"service": "guest",
		"event":   event,
	}
	for k, v := range fields {
		line[k] = v
	}
	data, err := json.Marshal(line)
	if err != nil {
		return
	}
	fmt.Fprintln(os.Stderr, string(data))
}
