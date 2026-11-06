package main

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"github.com/x402s/sandbox/guest/internal/protocol"
)

func TestParseTargetSpec(t *testing.T) {
	validBody := base64.StdEncoding.EncodeToString([]byte("hello"))
	tests := []struct {
		name     string
		port     int
		method   string
		path     string
		body     string
		headers  map[string]string
		wantCode string
	}{
		{name: "valid", port: 8080, method: "GET", path: "/", body: "", headers: nil},
		{name: "default method", port: 8080, method: "", path: "/", body: ""},
		{name: "valid post", port: 8080, method: "post", path: "/run", body: validBody},
		{name: "port too low", port: 80, method: "GET", path: "/", wantCode: "invalid_port"},
		{name: "port too high", port: 70000, method: "GET", path: "/", wantCode: "invalid_port"},
		{name: "bad method", port: 8080, method: "TRACE", path: "/", wantCode: "invalid_method"},
		{name: "no leading slash", port: 8080, method: "GET", path: "nope", wantCode: "invalid_path"},
		{name: "newline", port: 8080, method: "GET", path: "/a\nb", wantCode: "invalid_path"},
		{name: "bad base64", port: 8080, method: "POST", path: "/", body: "***", wantCode: "invalid_body"},
		{
			name:     "body too large",
			port:     8080,
			method:   "POST",
			path:     "/",
			body:     base64.StdEncoding.EncodeToString(make([]byte, maxHTTPBody+1)),
			wantCode: "body_too_large",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			spec, code, _ := parseTargetSpec(tt.port, tt.method, tt.path, tt.body, tt.headers)
			if code != tt.wantCode {
				t.Fatalf("code = %q, want %q", code, tt.wantCode)
			}
			if code == "" {
				if spec.port != tt.port || spec.path != tt.path {
					t.Fatalf("unexpected spec: %+v", spec)
				}
				if spec.method == "" {
					t.Fatal("method must default to GET")
				}
			}
		})
	}
}

func TestParseTargetSpecTooManyHeaders(t *testing.T) {
	headers := map[string]string{}
	for i := 0; i <= maxHTTPHeaders; i++ {
		headers[strings.Repeat("x", i+1)] = "v"
	}
	_, code, _ := parseTargetSpec(8080, "GET", "/", "", headers)
	if code != "too_many_headers" {
		t.Fatalf("code = %q, want too_many_headers", code)
	}
}

func TestRequestTimeoutClamps(t *testing.T) {
	if got := requestTimeout(&protocol.Request{TimeoutMs: 1000}, 30*time.Second); got != time.Second {
		t.Fatalf("got %s", got)
	}
	if got := requestTimeout(&protocol.Request{TimeoutMs: 60_000}, 30*time.Second); got != 30*time.Second {
		t.Fatalf("got %s", got)
	}
	if got := requestTimeout(&protocol.Request{}, 30*time.Second); got != 30*time.Second {
		t.Fatalf("got %s", got)
	}
}
