//go:build unix && !linux

package hardening

// Configure is a no-op on Unix platforms other than Linux (the suite runs the
// guest natively on macOS for protocol tests; production always runs on Linux).
func Configure(int) error { return nil }
