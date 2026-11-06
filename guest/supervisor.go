package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/x402s/sandbox/guest/internal/envelope"
	"github.com/x402s/sandbox/guest/internal/files"
	"github.com/x402s/sandbox/guest/internal/protocol"
	"github.com/x402s/sandbox/guest/internal/relay"
	"github.com/x402s/sandbox/guest/internal/runner"
)

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

	// Long-running local services (HTTP servers) started by the customer.
	services map[string]*runner.Service
	// Streaming HTTP responses opened by the customer.
	streams map[string]*httpStream
	// Bidirectional WebSocket streams opened by the customer.
	websockets map[string]*wsStream
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
	s.stopAllWS()
	s.stopAllStreams()
	s.stopAllServices()
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
	case protocol.OpServiceStart:
		result = s.startService(ctx, req)
	case protocol.OpServiceStop:
		result = s.stopService(req)
	case protocol.OpServiceList:
		result = s.listServices(req)
	case protocol.OpHTTP:
		result = s.httpRequest(ctx, req)
	case protocol.OpHTTPOpen:
		result = s.openStream(ctx, req)
	case protocol.OpHTTPRead:
		result = s.readStream(req)
	case protocol.OpHTTPClose:
		result = s.closeStreamRequest(req)
	case protocol.OpWSOpen:
		result = s.openWS(ctx, req)
	case protocol.OpWSRead:
		result = s.readWS(req)
	case protocol.OpWSSend:
		result = s.sendWS(ctx, req)
	case protocol.OpWSClose:
		result = s.closeWSRequest(req)
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
