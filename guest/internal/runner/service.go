package runner

import (
	"fmt"
	"net"
	"os/exec"
	"sync"
	"time"

	"github.com/x402s/sandbox/guest/internal/protocol"
)

// Service is a long-running child (a local HTTP server) that survives across
// operations until it is stopped, the lease ends, or the supervisor exits.
type Service struct {
	Name      string
	Port      int
	StartedAt time.Time

	cmd     *exec.Cmd
	pgid    int
	stdout  *LimitedBuffer
	stderr  *LimitedBuffer
	done    chan struct{}
	mu      sync.Mutex
	state   string
	exitErr int
}

// StartService launches a detached process group. The caller must Stop it.
func StartService(
	opts Options,
	name string,
	command []string,
	port int,
	cwd string,
	env map[string]string,
) (*Service, error) {
	if err := ValidateCommand(command); err != nil {
		return nil, err
	}
	if port < 1024 || port > 65535 {
		return nil, fmt.Errorf("port must be between 1024 and 65535")
	}

	childEnv := buildEnv(opts, env)
	path, err := resolveCommand(command[0], childEnv)
	if err != nil {
		return nil, err
	}
	// This is a sandbox command executor: the customer command is the
	// product input. The path is resolved only against the selected profile's
	// PATH and is executed inside the microVM.
	// codeql[js/command-line-injection]
	cmd := exec.Command(path, command[1:]...)
	cmd.Dir = cwd
	cmd.Env = childEnv
	limit := opts.MaxOutput
	if limit < 16*1024 {
		limit = 16 * 1024
	}
	stdout := NewLimitedBuffer(limit)
	stderr := NewLimitedBuffer(limit)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.SysProcAttr = procAttr()

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("could not start %q: %w", command[0], err)
	}
	svc := &Service{
		Name:      name,
		Port:      port,
		StartedAt: time.Now(),
		cmd:       cmd,
		pgid:      cmd.Process.Pid,
		stdout:    stdout,
		stderr:    stderr,
		done:      make(chan struct{}),
		state:     "running",
	}
	go func() {
		err := cmd.Wait()
		svc.mu.Lock()
		if svc.state == "running" {
			svc.state = "exited"
		}
		svc.exitErr = exitCode(err, cmd.ProcessState)
		svc.mu.Unlock()
		close(svc.done)
	}()
	return svc, nil
}

// WaitListening waits until the declared port accepts a loopback connection.
func (s *Service) WaitListening(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	addr := fmt.Sprintf("127.0.0.1:%d", s.Port)
	for time.Now().Before(deadline) {
		if !s.Running() {
			return fmt.Errorf("service exited before listening on %s: %s", addr, s.stderr.String())
		}
		conn, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("service did not listen on %s in time", addr)
}

func (s *Service) Running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state == "running"
}

// Stop kills the whole process group and waits briefly for it to exit.
func (s *Service) Stop() {
	s.mu.Lock()
	if s.state == "running" {
		s.state = "stopped"
	}
	s.mu.Unlock()
	killGroup(s.pgid)
	select {
	case <-s.done:
	case <-time.After(3 * time.Second):
	}
}

func (s *Service) Info() protocol.ServiceInfo {
	s.mu.Lock()
	state := s.state
	exit := s.exitErr
	s.mu.Unlock()
	info := protocol.ServiceInfo{
		Name:      s.Name,
		Port:      s.Port,
		PID:       s.pgid,
		State:     state,
		StartedAt: s.StartedAt.UnixMilli(),
		ExitCode:  exit,
		Stdout:    s.stdout.String(),
		Stderr:    s.stderr.String(),
	}
	return info
}
