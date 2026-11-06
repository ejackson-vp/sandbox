package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/x402s/sandbox/guest/internal/protocol"
	"github.com/x402s/sandbox/guest/internal/runner"
)

const (
	maxServices     = 4
	maxHTTPResponse = 4 * 1024 * 1024
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
	if existing, exists := s.services[name]; exists {
		if existing.Running() {
			s.mu.Unlock()
			return protocol.ErrorResult(req, "service_exists", "a service with that name already exists")
		}
		// A crashed service keeps its registry entry until someone notices.
		// Replacing a dead entry lets the customer restart the same name without
		// a separate stop round trip.
		delete(s.services, name)
	}
	for _, existing := range s.services {
		if existing.Running() && existing.Port == req.Port {
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
	target, errRes := s.httpTarget(req)
	if errRes != nil {
		return errRes
	}
	httpReq, cancel, err := target.newRequest(ctx, requestTimeout(req, 30*time.Second))
	if err != nil {
		return protocol.ErrorResult(req, "invalid_request", err.Error())
	}
	defer cancel()

	resp, err := target.client().Do(httpReq)
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
