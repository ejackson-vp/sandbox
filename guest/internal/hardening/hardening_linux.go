//go:build linux

package hardening

import "golang.org/x/sys/unix"

// Configure makes the supervisor non-dumpable, blocking ptrace and
// /proc/<pid>/mem reads from same-UID children.
//
// It deliberately does NOT set RLIMIT_NPROC: that limit is per-*UID*, and every
// sandbox on a node shares the same unprivileged UID, so a per-session value
// becomes a node-wide cap. At 25 concurrent sandboxes, a 256-task limit made
// fork() fail with EAGAIN and crashed guests (found by the density benchmark).
// Per-sandbox PID isolation comes from the pod cgroup (kubelet pod-max-pids).
func Configure(_ int) error {
	return unix.Prctl(unix.PR_SET_DUMPABLE, 0, 0, 0, 0)
}
