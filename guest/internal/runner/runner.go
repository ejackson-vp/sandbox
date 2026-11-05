package runner

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Result is the plaintext result that gets sealed to the customer's key.
type Result struct {
	V           int    `json:"v"`
	SessionID   string `json:"sessionId"`
	ClientNonce string `json:"clientNonce"`
	ExitCode    int    `json:"exitCode"`
	Stdout      string `json:"stdout"`
	Stderr      string `json:"stderr"`
	TimedOut    bool   `json:"timedOut"`
	DurationMs  int64  `json:"durationMs"`
	Truncated   struct {
		Stdout bool `json:"stdout"`
		Stderr bool `json:"stderr"`
	} `json:"truncated"`
}

// LimitedBuffer keeps the first N bytes and records truncation.
type LimitedBuffer struct {
	mu        sync.Mutex
	buf       bytes.Buffer
	limit     int
	truncated bool
}

func NewLimitedBuffer(limit int) *LimitedBuffer {
	return &LimitedBuffer{limit: limit}
}

func (b *LimitedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	remaining := b.limit - b.buf.Len()
	if remaining <= 0 {
		b.truncated = true
		return len(p), nil
	}
	if len(p) > remaining {
		b.buf.Write(p[:remaining])
		b.truncated = true
		return len(p), nil
	}
	b.buf.Write(p)
	return len(p), nil
}

func (b *LimitedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func (b *LimitedBuffer) Truncated() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.truncated
}

// DefaultSandboxDir is a memory-backed emptyDir mounted by the pod spec.
const DefaultSandboxDir = "/run/x402"

// sandboxDir honours X402_SANDBOX_DIR so the same binary can be exercised on a
// developer laptop (outside a pod) during protocol tests.
func sandboxDir() string {
	if v := os.Getenv("X402_SANDBOX_DIR"); v != "" {
		return v
	}
	return DefaultSandboxDir
}

// Execute runs Python code inside the guest with a hard wall-clock budget.
//
// The child never inherits the guest's environment: the relay token, dev
// attestation key and proxy token must not leak into customer code. The proxy
// credential is passed only as part of HTTPS_PROXY, scoped to this session.
func Execute(
	ctx context.Context,
	sessionID, clientNonce, code, stdin string,
	budget time.Duration,
	outputLimit int,
	proxyURL, proxyToken string,
) (*Result, error) {
	dir := sandboxDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("prepare workspace: %w", err)
	}
	payload := filepath.Join(dir, "payload.py")
	if err := os.WriteFile(payload, []byte(code), 0o600); err != nil {
		return nil, fmt.Errorf("write payload: %w", err)
	}
	defer func() {
		_ = os.Remove(payload)
	}()

	execCtx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()

	cmd := exec.CommandContext(execCtx, "python3", "-I", "-B", payload)
	cmd.Dir = dir
	cmd.Env = childEnv(proxyURL, proxyToken)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	stdout := NewLimitedBuffer(outputLimit)
	stderr := NewLimitedBuffer(outputLimit)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}

	start := time.Now()
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start python: %w", err)
	}

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	timedOut := false
	var waitErr error
	select {
	case waitErr = <-done:
	case <-execCtx.Done():
		timedOut = true
		// Kill the whole process group so child processes cannot outlive the budget.
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		select {
		case waitErr = <-done:
		case <-time.After(2 * time.Second):
			waitErr = errors.New("process did not exit after SIGKILL")
		}
	}
	duration := time.Since(start)

	exitCode := 0
	if timedOut {
		exitCode = -1
	} else if waitErr != nil {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
		}
	}

	res := &Result{
		V:           1,
		SessionID:   sessionID,
		ClientNonce: clientNonce,
		ExitCode:    exitCode,
		Stdout:      stdout.String(),
		Stderr:      stderr.String(),
		TimedOut:    timedOut,
		DurationMs:  duration.Milliseconds(),
	}
	res.Truncated.Stdout = stdout.Truncated()
	res.Truncated.Stderr = stderr.Truncated()
	return res, nil
}

func childEnv(proxyURL, proxyToken string) []string {
	env := []string{
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"HOME=/tmp",
		"TMPDIR=/tmp",
		"LANG=C.UTF-8",
		"PYTHONUNBUFFERED=1",
		"PYTHONDONTWRITEBYTECODE=1",
		"PYTHONNOUSERSITE=1",
	}
	if proxyURL != "" {
		// Credentials travel as the proxy password; the proxy accepts both
		// Bearer and Basic forms.
		credentialed := strings.Replace(proxyURL, "http://", "http://x402:"+proxyToken+"@", 1)
		env = append(env,
			"HTTP_PROXY="+credentialed,
			"HTTPS_PROXY="+credentialed,
			"http_proxy="+credentialed,
			"https_proxy="+credentialed,
			"NO_PROXY=",
		)
	}
	return env
}
