// Command netprobe performs network-reachability probes from inside the sandbox
// namespace. It is used by tests/security to prove packet-level isolation
// against the real cluster CNI.
//
// Input: PROBES env var containing JSON:
//
//	[{"name":"k8s-api","kind":"tcp","target":"10.96.0.1:443","timeoutMs":3000},
//	 {"name":"public","kind":"https-proxy","url":"https://example.com/","proxy":"http://ip:3128","proxyToken":"..."}]
//
// Output: one JSON array on stdout: [{"name","ok","detail","ms"}]
package main

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"time"
)

type probe struct {
	Name       string `json:"name"`
	Kind       string `json:"kind"`
	Target     string `json:"target"`
	URL        string `json:"url"`
	Proxy      string `json:"proxy"`
	ProxyToken string `json:"proxyToken"`
	Hostname   string `json:"hostname"`
	TimeoutMs  int    `json:"timeoutMs"`
}

type outcome struct {
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
	Ms     int64  `json:"ms"`
}

func main() {
	raw := os.Getenv("PROBES")
	var probes []probe
	if err := json.Unmarshal([]byte(raw), &probes); err != nil {
		fmt.Fprintf(os.Stderr, "invalid PROBES: %v\n", err)
		os.Exit(2)
	}
	results := make([]outcome, 0, len(probes))
	for _, p := range probes {
		results = append(results, runProbe(p))
	}
	enc := json.NewEncoder(os.Stdout)
	_ = enc.Encode(results)
}

func runProbe(p probe) (out outcome) {
	timeout := time.Duration(p.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	start := time.Now()
	out = outcome{Name: p.Name, Kind: p.Kind}
	defer func() { out.Ms = time.Since(start).Milliseconds() }()

	switch p.Kind {
	case "tcp":
		conn, err := net.DialTimeout("tcp", p.Target, timeout)
		if err != nil {
			out.Detail = err.Error()
			return out
		}
		_ = conn.Close()
		out.OK = true
		out.Detail = "tcp connect succeeded"
		return out

	case "dns":
		names, err := net.LookupHost(p.Hostname)
		if err != nil {
			out.Detail = err.Error()
			return out
		}
		out.OK = true
		out.Detail = fmt.Sprintf("resolved %v", names)
		return out

	case "https-proxy":
		transport := &http.Transport{
			Proxy: func(*http.Request) (*url.URL, error) {
				u, err := url.Parse(p.Proxy)
				if err != nil {
					return nil, err
				}
				if p.ProxyToken != "" {
					u.User = url.UserPassword("x402", p.ProxyToken)
				}
				return u, nil
			},
			TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
		}
		client := &http.Client{Transport: transport, Timeout: timeout}
		resp, err := client.Get(p.URL)
		if err != nil {
			out.Detail = err.Error()
			return out
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		// Any HTTP response proves the tunnel worked.
		out.OK = resp.StatusCode > 0
		out.Detail = fmt.Sprintf("http status %d", resp.StatusCode)
		return out

	case "direct-https":
		client := &http.Client{Timeout: timeout, Transport: &http.Transport{
			Proxy:           nil,
			TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
		}}
		resp, err := client.Get(p.URL)
		if err != nil {
			out.Detail = err.Error()
			return out
		}
		defer resp.Body.Close()
		out.OK = resp.StatusCode > 0
		out.Detail = fmt.Sprintf("http status %d", resp.StatusCode)
		return out
	}

	out.Detail = "unknown probe kind"
	return out
}
