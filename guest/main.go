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
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/x402s/sandbox/guest/internal/attest"
	"github.com/x402s/sandbox/guest/internal/envelope"
	"github.com/x402s/sandbox/guest/internal/files"
	"github.com/x402s/sandbox/guest/internal/hardening"
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
		lease:      time.Now().Add(time.Duration(cfg.LeaseSeconds)*time.Second + 2*time.Second),
		inflight:   map[string]context.CancelFunc{},
		slots:      make(chan struct{}, 1),
		services:   map[string]*runner.Service{},
		streams:    map[string]*httpStream{},
		websockets: map[string]*wsStream{},
		transfers:  newTransferManager(ws, cfg.MaxTransferBytes),
		maxFile:    cfg.MaxFileBytes,
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
				MaxTransferBytes:  int64(parseIntEnv("MAX_TRANSFER_BYTES", 256*1024*1024)),
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
