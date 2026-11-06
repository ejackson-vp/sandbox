//go:build linux

package hardening

import "golang.org/x/sys/unix"

// Configure makes the supervisor non-dumpable (blocking ptrace and
// /proc/<pid>/mem reads from same-UID children) and caps the process count for
// the shared UID.
func Configure(maxProcesses int) error {
	if err := unix.Prctl(unix.PR_SET_DUMPABLE, 0, 0, 0, 0); err != nil {
		return err
	}
	if maxProcesses > 0 {
		limit := &unix.Rlimit{Cur: uint64(maxProcesses), Max: uint64(maxProcesses)}
		return unix.Setrlimit(unix.RLIMIT_NPROC, limit)
	}
	return nil
}
