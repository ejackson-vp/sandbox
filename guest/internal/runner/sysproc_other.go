//go:build !linux

package runner

import "syscall"

// procAttr places the child in its own process group. Pdeathsig is Linux-only;
// on other platforms the supervisor's process-group sweep covers cleanup.
func procAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}
