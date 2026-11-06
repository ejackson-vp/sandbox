package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/x402s/sandbox/guest/internal/protocol"
	"github.com/x402s/sandbox/guest/internal/runner"
)

const (
	maxServices      = 4
	maxHTTPBody      = 8 * 1024 * 1024
	maxHTTPResponse  = 4 * 1024 * 1024
	maxHTTPHeaders   = 64
	maxHTTPHeaderLen = 8 * 1024
)

var serviceName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

func (s *supervisor) startService(ctx context.Context, req *protocol.Request) *protocol.Result {
	_ = ctx
	name := strings.TrimSpace(req.Name)
	if !serviceName.MatchString(name) {
		return protocol.ErrorResult(req, "invalid_service_name", "service name must match [a-z][a-z0-9-]{0,31}")
	}
	if req.Port < 1024 || req.Port > 65535 {
		return protocol.ErrorResult(req, "invalid_port", "port must be between 1024 and 65535")
	}
	cwd := s.runner.Workspace
	if req.Cwd != "" {
		abs, err := s.workspace.Resolve(req.Cwd)
		if err != nil {
			return protocol.ErrorResult(req, "invalid_cwd", "working directory is outside the workspace")
		}
		cwd = abs
	}

	s.mu.Lock()
	if len(s.services) >= maxServices {
		s.mu.Unlock()
		return protocol.ErrorResult(req, "too_many_services", fmt.Sprintf("at most %d services", maxServices))
	}
	if _, exists := s.services[name]; exists {
		s.mu.Unlock()
		return protocol.ErrorResult(req, "service_exists", "a service with that name already exists")
	}
	for _, existing := range s.services {
		if existing.Port == req.Port {
			s.mu.Unlock()
			return protocol.ErrorResult(req, "port_in_use", "another service already declares that port")
		}
	}
	s.mu.Unlock()

	svc, err := runner.StartService(s.runner, name, req.Command, req.Port, cwd, req.Env)
	if err != nil {
		return protocol.ErrorResult(req, "service_start_failed", err.Error())
	}
	if err := svc.WaitListening(10 * time.Second); err != nil {
		svc.Stop()
		return protocol.ErrorResult(req, "service_not_listening", err.Error())
	}
	s.mu.Lock()
	s.services[name] = svc
	s.mu.Unlock()
	info := svc.Info()
	logEvent("guest_service_started", map[string]any{"name": name, "port": req.Port, "pid": info.PID})
	return &protocol.Result{
		V: 2, SessionID: req.SessionID, ClientNonce: req.ClientNonce, RequestID: req.RequestID,
		Op: protocol.OpServiceStart, OK: true, Service: &info,
	}
}

func (s *supervisor) stopService(req *protocol.Request) *protocol.Result {
	name := strings.TrimSpace(req.Name)
	s.mu.Lock()
	svc := s.services[name]
	delete(s.services, name)
	s.mu.Unlock()
	if svc == nil {
		return protocol.ErrorResult(req, "service_not_found", "no service with that name")
	}
	svc.Stop()
	logEvent("guest_service_stopped", map[string]any{"name": name})
	return &protocol.Result{
		V: 2, SessionID: req.SessionID, ClientNonce: req.ClientNonce, RequestID: req.RequestID,
		Op: protocol.OpServiceStop, OK: true,
	}
}

func (s *supervisor) listServices(req *protocol.Request) *protocol.Result {
	s.mu.Lock()
	infos := make([]protocol.ServiceInfo, 0, len(s.services))
	for _, svc := range s.services {
		infos = append(infos, svc.Info())
	}
	s.mu.Unlock()
	return &protocol.Result{
		V: 2, SessionID: req.SessionID, ClientNonce: req.ClientNonce, RequestID: req.RequestID,
		Op: protocol.OpServiceList, OK: true, Services: infos,
	}
}

func (s *supervisor) stopAllServices() {
	s.mu.Lock()
	services := make([]*runner.Service, 0, len(s.services))
	for _, svc := range s.services {
		services = append(services, svc)
	}
	s.services = map[string]*runner.Service{}
	s.mu.Unlock()
	for _, svc := range services {
		svc.Stop()
	}
}

func (s *supervisor) serviceByPort(port int) *runner.Service {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, svc := range s.services {
		if svc.Port == port && svc.Running() {
			return svc
		}
	}
	return nil
}

func (s *supervisor) httpRequest(ctx context.Context, req *protocol.Request) *protocol.Result {
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
	if len(req.Headers) > maxHTTPHeaders {
		return protocol.ErrorResult(req, "too_many_headers", "too many request headers")
	}

	dialer := &net.Dialer{Timeout: 5 * time.Second}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			// The host is deliberately ignored; HTTP is loopback-only and only
			// to a port declared by a running service.
			return dialer.DialContext(ctx, "tcp", fmt.Sprintf("127.0.0.1:%d", req.Port))
		},
	}
	timeout := 30 * time.Second
	if req.TimeoutMs > 0 {
		requested := time.Duration(req.TimeoutMs) * time.Millisecond
		if requested < timeout {
			timeout = requested
		}
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	httpReq, err := http.NewRequestWithContext(
		ctx, method, fmt.Sprintf("http://127.0.0.1:%d%s", req.Port, path), bytes.NewReader(body),
	)
	if err != nil {
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
		return protocol.ErrorResult(req, "http_error", err.Error())
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxHTTPResponse+1))
	if err != nil {
		return protocol.ErrorResult(req, "http_read_failed", err.Error())
	}
	truncated := len(data) > maxHTTPResponse
	if truncated {
		data = data[:maxHTTPResponse]
	}
	headers := make(map[string]string, len(resp.Header))
	for key, values := range resp.Header {
		if len(headers) >= maxHTTPHeaders {
			break
		}
		headers[key] = strings.Join(values, ", ")
	}
	return &protocol.Result{
		V: 2, SessionID: req.SessionID, ClientNonce: req.ClientNonce, RequestID: req.RequestID,
		Op: protocol.OpHTTP, OK: true,
		Status:        resp.StatusCode,
		Headers:       headers,
		BodyBase64:    base64.StdEncoding.EncodeToString(data),
		BodyTruncated: truncated,
	}
}
