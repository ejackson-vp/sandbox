package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/x402s/sandbox/guest/internal/protocol"
)

const (
	maxWSStreams = 4
	maxWSMessage = 4 * 1024 * 1024
	maxWSTotal   = 64 * 1024 * 1024
	wsIdle       = 60 * time.Second
)

type wsMessage struct {
	data   []byte
	binary bool
}

type wsStream struct {
	id     string
	conn   *websocket.Conn
	ch     chan wsMessage
	cancel context.CancelFunc
	status int

	writeMu  sync.Mutex
	mu       sync.Mutex
	err      string
	total    int64
	lastRead time.Time
}

func (s *supervisor) openWS(ctx context.Context, req *protocol.Request) *protocol.Result {
	if s.serviceByPort(req.Port) == nil {
		return protocol.ErrorResult(req, "service_unavailable", "no running service on that port")
	}
	path := req.Path
	if !strings.HasPrefix(path, "/") || len(path) > 4096 || strings.ContainsAny(path, "\r\n") {
		return protocol.ErrorResult(req, "invalid_path", "path must start with / and contain no newlines")
	}
	dialCtx, cancel := context.WithCancel(ctx)
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	client := &http.Client{
		Transport: &http.Transport{
			Proxy: nil,
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return dialer.DialContext(ctx, "tcp", fmt.Sprintf("127.0.0.1:%d", req.Port))
			},
		},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	conn, resp, err := websocket.Dial(
		dialCtx,
		fmt.Sprintf("ws://127.0.0.1:%d%s", req.Port, path),
		&websocket.DialOptions{
			HTTPClient:      client,
			CompressionMode: websocket.CompressionDisabled,
			HTTPHeader:      http.Header{"Origin": []string{fmt.Sprintf("http://127.0.0.1:%d", req.Port)}},
		},
	)
	if err != nil {
		cancel()
		return protocol.ErrorResult(req, "ws_error", err.Error())
	}
	conn.SetReadLimit(maxWSMessage)
	status := 101
	if resp != nil {
		status = resp.StatusCode
	}
	idBytes := make([]byte, 8)
	_, _ = rand.Read(idBytes)
	id := "ws_" + hex.EncodeToString(idBytes)
	st := &wsStream{
		id:       id,
		conn:     conn,
		ch:       make(chan wsMessage, 8),
		cancel:   cancel,
		status:   status,
		lastRead: time.Now(),
	}
	s.mu.Lock()
	if len(s.websockets) >= maxWSStreams {
		s.mu.Unlock()
		cancel()
		_ = conn.Close(websocket.StatusNormalClosure, "too many streams")
		return protocol.ErrorResult(req, "too_many_ws", fmt.Sprintf("at most %d websocket streams", maxWSStreams))
	}
	s.websockets[id] = st
	s.mu.Unlock()

	go st.pump(dialCtx)
	logEvent("guest_ws_opened", map[string]any{"streamId": id, "port": req.Port})
	return &protocol.Result{
		V: 2, SessionID: req.SessionID, ClientNonce: req.ClientNonce, RequestID: req.RequestID,
		Op: protocol.OpWSOpen, OK: true, StreamID: id, Status: status,
	}
}

func (st *wsStream) pump(ctx context.Context) {
	defer close(st.ch)
	for {
		typ, data, err := st.conn.Read(ctx)
		if err != nil {
			st.mu.Lock()
			if st.err == "" {
				st.err = err.Error()
			}
			st.mu.Unlock()
			return
		}
		st.mu.Lock()
		st.total += int64(len(data))
		tooBig := st.total > maxWSTotal
		if tooBig {
			st.err = "ws_too_large"
		}
		st.mu.Unlock()
		if tooBig {
			return
		}
		select {
		case st.ch <- wsMessage{data: data, binary: typ == websocket.MessageBinary}:
		case <-ctx.Done():
			return
		}
	}
}

func (s *supervisor) readWS(req *protocol.Request) *protocol.Result {
	s.mu.Lock()
	st := s.websockets[req.StreamID]
	s.mu.Unlock()
	if st == nil {
		return protocol.ErrorResult(req, "ws_not_found", "no such websocket stream")
	}
	st.mu.Lock()
	idle := time.Since(st.lastRead) > wsIdle
	st.lastRead = time.Now()
	st.mu.Unlock()
	if idle {
		s.closeWS(req.StreamID)
		return protocol.ErrorResult(req, "ws_idle", "websocket was idle for too long")
	}
	select {
	case message, ok := <-st.ch:
		if !ok {
			st.mu.Lock()
			err := st.err
			st.mu.Unlock()
			if err != "" {
				return protocol.ErrorResult(req, "ws_error", err)
			}
			return &protocol.Result{
				V: 2, SessionID: req.SessionID, ClientNonce: req.ClientNonce, RequestID: req.RequestID,
				Op: protocol.OpWSRead, OK: true, Done: true,
			}
		}
		return &protocol.Result{
			V: 2, SessionID: req.SessionID, ClientNonce: req.ClientNonce, RequestID: req.RequestID,
			Op: protocol.OpWSRead, OK: true,
			ChunkBase64: base64.StdEncoding.EncodeToString(message.data),
			Binary:      message.binary,
		}
	default:
		return &protocol.Result{
			V: 2, SessionID: req.SessionID, ClientNonce: req.ClientNonce, RequestID: req.RequestID,
			Op: protocol.OpWSRead, OK: true, Pending: true,
		}
	}
}

func (s *supervisor) sendWS(ctx context.Context, req *protocol.Request) *protocol.Result {
	s.mu.Lock()
	st := s.websockets[req.StreamID]
	s.mu.Unlock()
	if st == nil {
		return protocol.ErrorResult(req, "ws_not_found", "no such websocket stream")
	}
	data, err := base64.StdEncoding.DecodeString(req.BodyBase64)
	if err != nil {
		return protocol.ErrorResult(req, "invalid_body", "body is not valid base64")
	}
	if len(data) > maxWSMessage {
		return protocol.ErrorResult(req, "message_too_large", "websocket message exceeds the limit")
	}
	typ := websocket.MessageText
	if req.Binary {
		typ = websocket.MessageBinary
	}
	st.writeMu.Lock()
	err = st.conn.Write(ctx, typ, data)
	st.writeMu.Unlock()
	if err != nil {
		return protocol.ErrorResult(req, "ws_write_failed", err.Error())
	}
	return &protocol.Result{
		V: 2, SessionID: req.SessionID, ClientNonce: req.ClientNonce, RequestID: req.RequestID,
		Op: protocol.OpWSSend, OK: true, StreamID: req.StreamID,
	}
}

func (s *supervisor) closeWS(id string) {
	s.mu.Lock()
	st := s.websockets[id]
	delete(s.websockets, id)
	s.mu.Unlock()
	if st != nil {
		st.cancel()
		_ = st.conn.Close(websocket.StatusNormalClosure, "closed")
	}
}

func (s *supervisor) closeWSRequest(req *protocol.Request) *protocol.Result {
	s.closeWS(req.StreamID)
	logEvent("guest_ws_closed", map[string]any{"streamId": req.StreamID})
	return &protocol.Result{
		V: 2, SessionID: req.SessionID, ClientNonce: req.ClientNonce, RequestID: req.RequestID,
		Op: protocol.OpWSClose, OK: true, StreamID: req.StreamID,
	}
}

func (s *supervisor) stopAllWS() {
	s.mu.Lock()
	streams := make([]*wsStream, 0, len(s.websockets))
	for _, st := range s.websockets {
		streams = append(streams, st)
	}
	s.websockets = map[string]*wsStream{}
	s.mu.Unlock()
	for _, st := range streams {
		st.cancel()
		_ = st.conn.Close(websocket.StatusGoingAway, "session ended")
	}
}
