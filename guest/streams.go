package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/x402s/sandbox/guest/internal/protocol"
)

const (
	maxStreams     = 4
	maxStreamTotal = 64 * 1024 * 1024
	streamChunk    = 64 * 1024
	streamIdle     = 60 * time.Second
)

type httpStream struct {
	id      string
	status  int
	headers map[string]string

	ch     chan []byte
	cancel context.CancelFunc

	mu       sync.Mutex
	err      string
	total    int64
	lastRead time.Time
}

func (s *supervisor) openStream(ctx context.Context, req *protocol.Request) *protocol.Result {
	if s.serviceByPort(req.Port) == nil {
		return protocol.ErrorResult(req, "service_unavailable", "no running service on that port")
	}
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	switch method {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodHead, http.MethodOptions:
	default:
		return protocol.ErrorResult(req, "invalid_method", "unsupported HTTP method")
	}
	path := req.Path
	if !strings.HasPrefix(path, "/") || len(path) > 4096 || strings.ContainsAny(path, "\r\n") {
		return protocol.ErrorResult(req, "invalid_path", "path must start with / and contain no newlines")
	}
	body, err := base64.StdEncoding.DecodeString(req.BodyBase64)
	if err != nil {
		return protocol.ErrorResult(req, "invalid_body", "body is not valid base64")
	}
	if len(body) > maxHTTPBody {
		return protocol.ErrorResult(req, "body_too_large", "request body exceeds the limit")
	}

	streamCtx, cancel := context.WithCancel(ctx)
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "tcp", fmt.Sprintf("127.0.0.1:%d", req.Port))
		},
	}
	client := &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	httpReq, err := http.NewRequestWithContext(
		streamCtx, method, fmt.Sprintf("http://127.0.0.1:%d%s", req.Port, path), bytes.NewReader(body),
	)
	if err != nil {
		cancel()
		return protocol.ErrorResult(req, "invalid_request", err.Error())
	}
	for key, value := range req.Headers {
		lower := strings.ToLower(key)
		if len(key) > 128 || len(value) > maxHTTPHeaderLen {
			continue
		}
		switch lower {
		case "host", "connection", "transfer-encoding", "content-length", "proxy-connection", "upgrade":
			continue
		}
		httpReq.Header.Set(key, value)
	}

	resp, err := client.Do(httpReq)
	if err != nil {
		cancel()
		return protocol.ErrorResult(req, "http_error", err.Error())
	}
	idBytes := make([]byte, 8)
	_, _ = rand.Read(idBytes)
	id := "st_" + hex.EncodeToString(idBytes)
	headers := make(map[string]string, len(resp.Header))
	for key, values := range resp.Header {
		if len(headers) >= maxHTTPHeaders {
			break
		}
		headers[key] = strings.Join(values, ", ")
	}
	st := &httpStream{
		id:       id,
		status:   resp.StatusCode,
		headers:  headers,
		ch:       make(chan []byte, 8),
		cancel:   cancel,
		lastRead: time.Now(),
	}

	s.mu.Lock()
	if len(s.streams) >= maxStreams {
		s.mu.Unlock()
		cancel()
		_ = resp.Body.Close()
		return protocol.ErrorResult(req, "too_many_streams", fmt.Sprintf("at most %d streams", maxStreams))
	}
	s.streams[id] = st
	s.mu.Unlock()

	go st.pump(streamCtx, resp.Body)
	logEvent("guest_stream_opened", map[string]any{"streamId": id, "port": req.Port, "status": resp.StatusCode})
	return &protocol.Result{
		V: 2, SessionID: req.SessionID, ClientNonce: req.ClientNonce, RequestID: req.RequestID,
		Op: protocol.OpHTTPOpen, OK: true,
		StreamID: id, Status: resp.StatusCode, Headers: headers,
	}
}

func (st *httpStream) pump(ctx context.Context, body io.ReadCloser) {
	defer close(st.ch)
	defer body.Close()
	buf := make([]byte, streamChunk)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			st.mu.Lock()
			st.total += int64(n)
			tooBig := st.total > maxStreamTotal
			if tooBig {
				st.err = "stream_too_large"
			}
			st.mu.Unlock()
			if tooBig {
				return
			}
			select {
			case st.ch <- chunk:
			case <-ctx.Done():
				return
			}
		}
		if err != nil {
			if err != io.EOF {
				st.mu.Lock()
				if st.err == "" {
					st.err = err.Error()
				}
				st.mu.Unlock()
			}
			return
		}
	}
}

func (s *supervisor) readStream(req *protocol.Request) *protocol.Result {
	s.mu.Lock()
	st := s.streams[req.StreamID]
	s.mu.Unlock()
	if st == nil {
		return protocol.ErrorResult(req, "stream_not_found", "no such stream")
	}
	st.mu.Lock()
	idle := time.Since(st.lastRead) > streamIdle
	st.lastRead = time.Now()
	st.mu.Unlock()
	if idle {
		s.closeStream(req.StreamID)
		return protocol.ErrorResult(req, "stream_idle", "stream was idle for too long")
	}

	select {
	case chunk, ok := <-st.ch:
		if !ok {
			st.mu.Lock()
			err := st.err
			st.mu.Unlock()
			if err != "" {
				return protocol.ErrorResult(req, "stream_error", err)
			}
			return &protocol.Result{
				V: 2, SessionID: req.SessionID, ClientNonce: req.ClientNonce, RequestID: req.RequestID,
				Op: protocol.OpHTTPRead, OK: true, Done: true,
			}
		}
		return &protocol.Result{
			V: 2, SessionID: req.SessionID, ClientNonce: req.ClientNonce, RequestID: req.RequestID,
			Op: protocol.OpHTTPRead, OK: true,
			ChunkBase64: base64.StdEncoding.EncodeToString(chunk),
		}
	default:
		return &protocol.Result{
			V: 2, SessionID: req.SessionID, ClientNonce: req.ClientNonce, RequestID: req.RequestID,
			Op: protocol.OpHTTPRead, OK: true, Pending: true,
		}
	}
}

func (s *supervisor) closeStream(id string) {
	s.mu.Lock()
	st := s.streams[id]
	delete(s.streams, id)
	s.mu.Unlock()
	if st != nil {
		st.cancel()
	}
}

func (s *supervisor) closeStreamRequest(req *protocol.Request) *protocol.Result {
	s.closeStream(req.StreamID)
	logEvent("guest_stream_closed", map[string]any{"streamId": req.StreamID})
	return &protocol.Result{
		V: 2, SessionID: req.SessionID, ClientNonce: req.ClientNonce, RequestID: req.RequestID,
		Op: protocol.OpHTTPClose, OK: true, StreamID: req.StreamID,
	}
}

func (s *supervisor) stopAllStreams() {
	s.mu.Lock()
	streams := make([]*httpStream, 0, len(s.streams))
	for _, st := range s.streams {
		streams = append(streams, st)
	}
	s.streams = map[string]*httpStream{}
	s.mu.Unlock()
	for _, st := range streams {
		st.cancel()
	}
}
