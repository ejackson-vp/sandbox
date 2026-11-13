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

	// Relay identity for reconnect. The supervisor keeps the URL (with the
	// guest token) and the evidence it attested at boot, so a reconnected guest
	// presents the same session, token and ephemeral key. Re-keying would make
	// every envelope the client already sealed undecryptable.
	relayURL string
	evidence map[string]any

	mu       sync.Mutex
	inflight map[string]context.CancelFunc
	slots    chan struct{}
	// handlers tracks in-flight operation goroutines. A link loss waits on it
	// before reconnecting: the aborted command must be gone (its process group
	// killed) before the guest can honestly report an idle slot.
	handlers sync.WaitGroup

	// Execution-epoch high-water mark and the request holding the single slot.
	// Guarded by mu. The controller reads both through the relay. Both survive a
	// relay reconnect: the fence is per session, not per socket.
	epoch  int64
	active string

	// Long-running local services (HTTP servers) started by the customer.
	services map[string]*runner.Service
	// Streaming HTTP responses opened by the customer.
	streams map[string]*httpStream
	// Bidirectional WebSocket streams opened by the customer.
	websockets map[string]*wsStream
	transfers  *transferManager
}

// errLeaseEnded is the reconnect loop's stop condition: the session has no time
// left, so there is nothing to reconnect for.
var errLeaseEnded = errors.New("lease ended before the relay link returned")

// serve runs one relay link at a time. A lost link (not lease expiry, not an
// explicit shutdown) aborts the operation it carried and reconnects with
// bounded backoff, keeping the workspace and the customer's long-running
// services. It returns nil for a clean end: lease expiry or shutdown.
func (s *supervisor) serve(ctx context.Context) error {
	defer func() { s.conn.Close() }()
	for {
		err := s.serveLink(ctx)
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			// SIGTERM/SIGINT: a clean stop, not a failed session.
			logEvent("guest_shutdown", map[string]any{"sessionId": s.sessionID})
			return nil
		}
		if !s.lease.After(time.Now()) {
			logEvent("guest_lease_ended", map[string]any{"sessionId": s.sessionID})
			s.shutdownAll()
			return nil
		}

		// The link that carried an operation is gone: cancel and kill it, and
		// never answer it. The controller has already been told (or will be)
		// that its outcome is unknown; a reply would be a fabricated result.
		logEvent("guest_relay_lost", map[string]any{
			"sessionId": s.sessionID,
			"error":     err.Error(),
		})
		s.abortInflight()
		s.conn.Close()

		client, dialErr := s.reconnect(ctx)
		if dialErr != nil {
			if errors.Is(dialErr, errLeaseEnded) || ctx.Err() != nil {
				logEvent("guest_lease_ended", map[string]any{"sessionId": s.sessionID})
				s.shutdownAll()
				return nil
			}
			return dialErr
		}
		s.conn = client
		if helloErr := s.conn.SendHello(ctx, s.evidence); helloErr != nil {
			logEvent("guest_hello_failed", map[string]any{
				"sessionId": s.sessionID,
				"error":     helloErr.Error(),
			})
			continue
		}
		// Idle is published before the first frame of the new link so a
		// recovery fence can clear without waiting for an operation. The epoch
		// is the surviving high-water mark; a frame below it is still rejected.
		s.publishStatus(ctx, s.conn)
		logEvent("guest_relay_reconnected", map[string]any{"sessionId": s.sessionID})
	}
}

// serveLink reads frames until the link fails, the lease ends or the controller
// asks the guest to stop. In-flight operations are bound to this link's context,
// so a read error cancels them before the caller reconnects.
func (s *supervisor) serveLink(ctx context.Context) error {
	linkCtx, cancelLink := context.WithCancel(ctx)
	defer cancelLink()

	// The controller must be able to tell "idle" apart from "has not reported
	// status yet", so publish once before the first frame.
	s.publishStatus(linkCtx, s.conn)
	for {
		readCtx, cancel := context.WithDeadline(linkCtx, s.lease)
		frame, err := s.conn.Read(readCtx)
		expired := readCtx.Err() != nil
		cancel()
		if err != nil {
			if expired || ctx.Err() != nil {
				// The lease is the only reason this loop stops without a link:
				// the supervisor kills every descendant on the way out.
				s.shutdownAll()
				return nil
			}
			return fmt.Errorf("relay read: %w", err)
		}
		switch frame.Type {
		case "request":
			if frame.ID == "" || frame.Envelope == "" {
				continue
			}
			s.handlers.Add(1)
			go func(conn *relay.Client, frame *relay.Frame) {
				defer s.handlers.Done()
				s.handleRequest(linkCtx, conn, frame)
			}(s.conn, frame)
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

// reconnect re-dials until the lease ends. Backoff is bounded so a relay that
// comes back is picked up in seconds, and a 401 (a guest token the relay will
// never accept) ends the session instead of retrying.
func (s *supervisor) reconnect(ctx context.Context) (*relay.Client, error) {
	backoff := 250 * time.Millisecond
	for {
		if !s.lease.After(time.Now()) {
			return nil, errLeaseEnded
		}
		dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		client, err := relay.DialOnce(dialCtx, s.relayURL)
		cancel()
		if err == nil {
			return client, nil
		}
		var statusErr *relay.StatusError
		if errors.As(err, &statusErr) && statusErr.Permanent() {
			logEvent("guest_relay_rejected", map[string]any{
				"sessionId": s.sessionID,
				"status":    statusErr.Status,
			})
			return nil, err
		}
		wait := backoff
		if remaining := time.Until(s.lease); remaining < wait {
			wait = remaining
		}
		if wait < 0 {
			wait = 0
		}
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		if backoff < 4*time.Second {
			backoff *= 2
		}
	}
}

// abortInflight cancels every relay-bound operation and waits for their
// goroutines to finish, so the process group is gone and the single slot is
// free before the guest reports status on a new link. Customer services, open
// streams and the workspace are deliberately untouched.
func (s *supervisor) abortInflight() {
	s.mu.Lock()
	fns := make([]context.CancelFunc, 0, len(s.inflight))
	for _, fn := range s.inflight {
		fns = append(fns, fn)
	}
	s.mu.Unlock()
	for _, fn := range fns {
		fn()
	}
	done := make(chan struct{})
	go func() {
		s.handlers.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		// A command that outlived the cancel still holds the slot. Report it
		// honestly (publishStatus reads `active`) rather than claiming idle.
		logEvent("guest_inflight_drain_timeout", map[string]any{"sessionId": s.sessionID})
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

// admitEpoch fences requests against the highest execution epoch this guest has
// accepted. epoch 0 means "no fence" (legacy callers/tests); real controller
// frames always carry a positive epoch.
func (s *supervisor) admitEpoch(epoch int64) bool {
	if epoch <= 0 {
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if epoch < s.epoch {
		return false
	}
	if epoch > s.epoch {
		s.epoch = epoch
	}
	return true
}

// publishStatus reports the execution slot to the relay. Failure is logged but
// never fails the operation: the controller then keeps its recovery fence
// closed, which is the safe direction.
func (s *supervisor) publishStatus(ctx context.Context, conn *relay.Client) {
	s.mu.Lock()
	active, epoch := s.active, s.epoch
	s.mu.Unlock()
	if err := conn.SendStatus(ctx, active, epoch); err != nil {
		if ctx.Err() == nil {
			logEvent("guest_status_failed", map[string]any{"error": err.Error()})
		}
	}
}

func (s *supervisor) shutdownAll() {
	s.transfers.shutdown()
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
// `conn` is the link the frame arrived on: a response must never travel over a
// later link, where it would be indistinguishable from the outcome of an
// operation the controller has already given up on.
func (s *supervisor) handleRequest(ctx context.Context, conn *relay.Client, frame *relay.Frame) {
	// One operation at a time per session. The controller also enforces this;
	// the guest does so again so a buggy/compromised client cannot race.
	select {
	case s.slots <- struct{}{}:
	case <-ctx.Done():
		return
	case <-time.After(10 * time.Second):
		s.replyPlain(ctx, conn, frame.ID, protocol.ErrorResult(&protocol.Request{
			V: 2, SessionID: s.sessionID, ClientNonce: s.clientNonce, RequestID: frame.ID, Op: "exec",
		}, "busy", "another operation is still running"))
		return
	}

	// Admit the request's execution epoch under the slot. A frame forwarded by
	// a controller generation older than one we have already accepted is
	// rejected: it must never start after recovery.
	if !s.admitEpoch(frame.Epoch) {
		<-s.slots
		s.replyPlain(ctx, conn, frame.ID, protocol.ErrorResult(&protocol.Request{
			V: 2, SessionID: s.sessionID, ClientNonce: s.clientNonce, RequestID: frame.ID, Op: "exec",
		}, "stale_epoch", "the request belongs to a previous controller generation"))
		return
	}

	opCtx, cancel := context.WithCancel(ctx)
	s.mu.Lock()
	s.inflight[frame.ID] = cancel
	s.active = frame.ID
	s.mu.Unlock()
	s.publishStatus(ctx, conn)
	defer func() {
		cancel()
		s.mu.Lock()
		delete(s.inflight, frame.ID)
		if s.active == frame.ID {
			s.active = ""
		}
		s.mu.Unlock()
		// Publish idle before releasing the slot so the next operation's start
		// status can never overtake this one. On a dead link this is skipped:
		// the reconnect publishes the state of the new link instead.
		if ctx.Err() == nil {
			s.publishStatus(ctx, conn)
		}
		<-s.slots
	}()

	req, err := s.decrypt(frame)
	if err != nil {
		s.replyPlain(ctx, conn, frame.ID, protocol.ErrorResult(&protocol.Request{
			V: 2, SessionID: s.sessionID, ClientNonce: s.clientNonce, RequestID: frame.ID, Op: "exec",
		}, "invalid_request", err.Error()))
		return
	}

	// Never let an operation outlive the lease.
	if !s.lease.After(time.Now()) {
		s.reply(ctx, conn, req, protocol.ErrorResult(req, "lease_expired", "the session lease has ended"))
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
	case protocol.OpTransferInit:
		result = s.transfers.init(req)
	case protocol.OpTransferChunk:
		result = s.transfers.chunk(req)
	case protocol.OpTransferComplete:
		result = s.transfers.complete(req)
	case protocol.OpTransferStatus:
		result = s.transfers.status(req)
	case protocol.OpTransferRead:
		result = s.transfers.read(req)
	case protocol.OpTransferCancel:
		result = s.transfers.cancel(req)
	default:
		result = protocol.ErrorResult(req, "unsupported_operation", "unknown operation")
	}
	s.reply(ctx, conn, req, result)
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

func (s *supervisor) reply(ctx context.Context, conn *relay.Client, req *protocol.Request, result *protocol.Result) {
	plain, err := json.Marshal(result)
	if err != nil {
		s.replyPlain(ctx, conn, req.RequestID, protocol.ErrorResult(req, "encoding_failed", "could not encode result"))
		return
	}
	sealed, err := envelope.Seal(s.clientKey, plain)
	for i := range plain {
		plain[i] = 0
	}
	if err != nil {
		s.replyPlain(ctx, conn, req.RequestID, protocol.ErrorResult(req, "encryption_failed", "could not encrypt result"))
		return
	}
	if err := conn.SendResponse(ctx, req.RequestID, sealed); err != nil {
		// A reply on a link the controller has already given up on is not a
		// result: the operation's outcome stays unknown on the controller side.
		// A cancelled link is expected here, so it is not logged as a failure.
		if ctx.Err() == nil {
			logEvent("guest_reply_failed", map[string]any{"requestId": req.RequestID})
		}
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
func (s *supervisor) replyPlain(ctx context.Context, conn *relay.Client, id string, result *protocol.Result) {
	plain, err := json.Marshal(result)
	if err != nil {
		return
	}
	sealed, err := envelope.Seal(s.clientKey, plain)
	if err != nil {
		return
	}
	_ = conn.SendResponse(ctx, id, sealed)
}

// bootstrap writes credentials to a mode-0400 file for the main container.
