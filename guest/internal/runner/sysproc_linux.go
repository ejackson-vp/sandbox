//go:build linux

package runner

import "syscall"

// procAttr places the child in its own process group and asks the kernel to
// kill it if the supervisor dies.
func procAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}
