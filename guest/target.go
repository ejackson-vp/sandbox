package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/x402s/sandbox/guest/internal/protocol"
	"github.com/x402s/sandbox/guest/internal/runner"
)

const (
	maxHTTPBody      = 8 * 1024 * 1024
	maxHTTPHeaders   = 64
	maxHTTPHeaderLen = 8 * 1024
)

// targetSpec is a validated loopback request. It deliberately has no host
// field: the host is always 127.0.0.1 and the port must be a declared service.
type targetSpec struct {
	port    int
	method  string
	path    string
	body    []byte
	headers map[string]string
}

func parseTargetSpec(
	port int,
	method string,
	path string,
	bodyBase64 string,
	headers map[string]string,
) (targetSpec, string, string) {
	if port < 1024 || port > 65535 {
		return targetSpec{}, "invalid_port", "port must be between 1024 and 65535"
	}
	method = strings.ToUpper(strings.TrimSpace(method))
	if method == "" {
		method = http.MethodGet
	}
	switch method {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch,
		http.MethodDelete, http.MethodHead, http.MethodOptions:
	default:
		return targetSpec{}, "invalid_method", "unsupported HTTP method"
	}
	if !strings.HasPrefix(path, "/") || len(path) > 4096 || strings.ContainsAny(path, "\r\n") {
		return targetSpec{}, "invalid_path", "path must start with / and contain no newlines"
	}
	body, err := base64.StdEncoding.DecodeString(bodyBase64)
	if err != nil {
		return targetSpec{}, "invalid_body", "body is not valid base64"
	}
	if len(body) > maxHTTPBody {
		return targetSpec{}, "body_too_large", "request body exceeds the limit"
	}
	if len(headers) > maxHTTPHeaders {
		return targetSpec{}, "too_many_headers", "too many request headers"
	}
	return targetSpec{port: port, method: method, path: path, body: body, headers: headers}, "", ""
}

type httpTarget struct {
	spec    targetSpec
	service *runner.Service
}

func (s *supervisor) httpTarget(req *protocol.Request) (*httpTarget, *protocol.Result) {
	if s.serviceByPort(req.Port) == nil {
		return nil, protocol.ErrorResult(req, "service_unavailable", "no running service on that port")
	}
	spec, code, message := parseTargetSpec(req.Port, req.Method, req.Path, req.BodyBase64, req.Headers)
	if code != "" {
		return nil, protocol.ErrorResult(req, code, message)
	}
	return &httpTarget{spec: spec, service: s.serviceByPort(req.Port)}, nil
}

// client always dials loopback and never uses a proxy. Redirects are surfaced
// to the caller rather than followed.
func (t *httpTarget) client() *http.Client {
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	return &http.Client{
		Transport: &http.Transport{
			Proxy: nil,
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return dialer.DialContext(ctx, "tcp", fmt.Sprintf("127.0.0.1:%d", t.spec.port))
			},
		},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func (t *httpTarget) newRequest(ctx context.Context, timeout time.Duration) (*http.Request, context.CancelFunc, error) {
	reqCtx := ctx
	cancel := func() {}
	if timeout > 0 {
		reqCtx, cancel = context.WithTimeout(ctx, timeout)
	}
	req, err := http.NewRequestWithContext(
		reqCtx,
		t.spec.method,
		fmt.Sprintf("http://127.0.0.1:%d%s", t.spec.port, t.spec.path),
		bytes.NewReader(t.spec.body),
	)
	if err != nil {
		cancel()
		return nil, func() {}, err
	}
	for key, value := range t.spec.headers {
		lower := strings.ToLower(key)
		if len(key) > 128 || len(value) > maxHTTPHeaderLen {
			continue
		}
		switch lower {
		case "host", "connection", "transfer-encoding", "content-length", "proxy-connection", "upgrade":
			continue
		}
		req.Header.Set(key, value)
	}
	return req, cancel, nil
}

func (t *httpTarget) origin() string {
	return fmt.Sprintf("http://127.0.0.1:%d", t.spec.port)
}

func (t *httpTarget) wsURL() string {
	return fmt.Sprintf("ws://127.0.0.1:%d%s", t.spec.port, t.spec.path)
}

func requestTimeout(req *protocol.Request, fallback time.Duration) time.Duration {
	if req.TimeoutMs <= 0 {
		return fallback
	}
	requested := time.Duration(req.TimeoutMs) * time.Millisecond
	if requested < fallback {
		return requested
	}
	return fallback
}
