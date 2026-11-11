package runner

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/x402s/sandbox/guest/internal/protocol"
)

// Options are fixed for the lifetime of the sandbox.
type Options struct {
	Workspace  string
	ProxyURL   string
	ProxyToken string
	MaxOutput  int
	MaxCommand time.Duration
	// ProfileEnv is the trusted environment from the selected runtime profile.
	// It is applied before request overrides so a customer can still set their
	// own values for a command.
	ProfileEnv map[string]string
}

var envKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

var blockedEnv = map[string]struct{}{
	"LD_PRELOAD":   {},
	"LD_AUDIT":     {},
	"GCONV_PATH":   {},
	"MALLOC_TRACE": {},
}

// LimitedBuffer keeps the first N bytes and records truncation.
type LimitedBuffer struct {
	mu        sync.Mutex
	buf       bytes.Buffer
	limit     int
	truncated bool
}

func NewLimitedBuffer(limit int) *LimitedBuffer { return &LimitedBuffer{limit: limit} }

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

// ValidateCommand checks argv before anything is spawned.
func ValidateCommand(command []string) error {
	if len(command) == 0 {
		return errors.New("command must not be empty")
	}
	if len(command) > 256 {
		return errors.New("too many arguments")
	}
	total := 0
	for _, arg := range command {
		if arg == "" && len(command) > 1 {
			return errors.New("empty argument is not allowed")
		}
		if strings.ContainsRune(arg, 0) {
			return errors.New("NUL byte in argument")
		}
		total += len(arg)
	}
	if total > 128*1024 {
		return errors.New("arguments too large")
	}
	return nil
}

// Execute runs one command and always returns a result (never panics).
//
// ctx cancellation is reported as `cancelled` when the deadline was not the
// cause; a deadline yields `timedOut`. Both kill the whole process group, so
// descendants cannot outlive the command.
func Execute(ctx context.Context, opts Options, req *protocol.Request, cwd string, timeout time.Duration) *protocol.Result {
	start := time.Now()
	result := &protocol.Result{
		V:           2,
		SessionID:   req.SessionID,
		ClientNonce: req.ClientNonce,
		RequestID:   req.RequestID,
		Op:          protocol.OpExec,
		OK:          true,
	}

	if err := ValidateCommand(req.Command); err != nil {
		return protocol.ErrorResult(req, "invalid_command", err.Error())
	}
	if timeout <= 0 {
		return protocol.ErrorResult(req, "lease_expired", "no execution time remaining")
	}
	if timeout > opts.MaxCommand {
		timeout = opts.MaxCommand
	}

	env := buildEnv(opts, req.Env)
	path, err := resolveCommand(req.Command[0], env)
	if err != nil {
		return protocol.ErrorResult(req, "spawn_failed", err.Error())
	}
	// This is a sandbox command executor: the customer command is the
	// product input. The path is resolved only against the selected profile's
	// PATH and is executed inside the microVM.
	// codeql[js/command-line-injection]
	cmd := exec.Command(path, req.Command[1:]...)
	cmd.Dir = cwd
	cmd.Env = env
	if req.Stdin != "" {
		cmd.Stdin = strings.NewReader(req.Stdin)
	}
	stdout := NewLimitedBuffer(opts.MaxOutput)
	stderr := NewLimitedBuffer(opts.MaxOutput)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.SysProcAttr = procAttr()

	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	if err := cmd.Start(); err != nil {
		return protocol.ErrorResult(req, "spawn_failed", fmt.Sprintf("could not start %q: %v", req.Command[0], err))
	}
	pgid := cmd.Process.Pid

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	var waitErr error
	cancelled := false
	timedOut := false
	select {
	case waitErr = <-done:
	case <-runCtx.Done():
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) && ctx.Err() == nil {
			timedOut = true
		} else {
			cancelled = true
		}
		killGroup(pgid)
		select {
		case waitErr = <-done:
		case <-time.After(3 * time.Second):
			waitErr = errors.New("process did not exit after SIGKILL")
		}
	}
	// Always sweep the process group: background children must not survive the
	// command that produced them.
	killGroup(pgid)

	result.ExitCode = exitCode(waitErr, cmd.ProcessState) //nolint:misspell
	result.Stdout = stdout.String()
	result.Stderr = stderr.String()
	result.TimedOut = timedOut
	result.Cancelled = cancelled
	result.DurationMs = time.Since(start).Milliseconds()
	result.Truncated.Stdout = stdout.Truncated()
	result.Truncated.Stderr = stderr.Truncated()
	return result
}

// resolveCommand applies the child PATH, not the supervisor's. Go's
// exec.Command/LookPath resolves the executable against the supervisor's
// environment, so a profile PATH would be ignored and every language binary
// would look missing.
func resolveCommand(name string, env []string) (string, error) {
	if strings.ContainsRune(name, os.PathSeparator) {
		if executable(name) {
			return name, nil
		}
		return "", fmt.Errorf("could not start %q: executable file not found", name)
	}
	pathValue := ""
	for _, entry := range env {
		if strings.HasPrefix(entry, "PATH=") {
			pathValue = strings.TrimPrefix(entry, "PATH=")
			break
		}
	}
	for _, dir := range filepath.SplitList(pathValue) {
		if dir == "" {
			dir = "."
		}
		candidate := filepath.Join(dir, name)
		if executable(candidate) {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("could not start %q: executable file not found in $PATH", name)
}

func executable(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Mode()&0o111 != 0
}

func killGroup(pgid int) {
	if pgid <= 1 {
		return
	}
	_ = syscall.Kill(-pgid, syscall.SIGKILL)
}

func exitCode(err error, state *os.ProcessState) int {
	if state == nil {
		if err == nil {
			return 0
		}
		return -1
	}
	if ws, ok := state.Sys().(syscall.WaitStatus); ok {
		if ws.Signaled() {
			return 128 + int(ws.Signal())
		}
		return ws.ExitStatus()
	}
	if err != nil {
		return -1
	}
	return state.ExitCode()
}

// buildEnv starts from a fixed, minimal base and merges validated overrides.
// The guest's own environment (relay token, keys) is never inherited.
func buildEnv(opts Options, overrides map[string]string) []string {
	base := []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=" + opts.Workspace,
		"TMPDIR=" + opts.Workspace + "/.tmp",
		"LANG=C.UTF-8",
		"LC_ALL=C.UTF-8",
		"TERM=dumb",
		"PYTHONUNBUFFERED=1",
		"PYTHONDONTWRITEBYTECODE=1",
		"PYTHONNOUSERSITE=1",
		"NPM_CONFIG_CACHE=" + opts.Workspace + "/.npm",
		"NODE_PATH=/usr/lib/node_modules",
	}
	if opts.ProxyURL != "" {
		credentialed := strings.Replace(opts.ProxyURL, "http://", "http://x402:"+opts.ProxyToken+"@", 1)
		base = append(base,
			"HTTP_PROXY="+credentialed,
			"HTTPS_PROXY="+credentialed,
			"http_proxy="+credentialed,
			"https_proxy="+credentialed,
			"NO_PROXY=",
			"no_proxy=",
		)
	}
	base = applyEnv(base, opts.ProfileEnv)
	return applyEnv(base, overrides)
}

func applyEnv(base []string, values map[string]string) []string {
	if len(values) == 0 {
		return base
	}
	index := map[string]int{}
	for i, kv := range base {
		index[strings.SplitN(kv, "=", 2)[0]] = i
	}
	for k, v := range values {
		if !envKey.MatchString(k) {
			continue
		}
		if _, blocked := blockedEnv[k]; blocked {
			continue
		}
		if strings.ContainsRune(v, 0) || len(v) > 8192 {
			continue
		}
		entry := k + "=" + v
		if i, ok := index[k]; ok {
			base[i] = entry
		} else {
			index[k] = len(base)
			base = append(base, entry)
		}
	}
	return base
}
