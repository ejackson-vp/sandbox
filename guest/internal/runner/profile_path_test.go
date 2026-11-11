package runner

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/x402s/sandbox/guest/internal/protocol"
)

func TestExecuteResolvesTheProfilePath(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "profile-tool")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nprintf profile-path-ok\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	result := Execute(context.Background(), Options{
		Workspace:  t.TempDir(),
		MaxOutput:  4096,
		MaxCommand: time.Second,
		ProfileEnv: map[string]string{"PATH": dir},
	}, &protocol.Request{
		SessionID:   "sbx_profile_path",
		ClientNonce: "nonce",
		Command:     []string{"profile-tool"},
	}, t.TempDir(), time.Second)
	if !result.OK || result.ExitCode != 0 || result.Stdout != "profile-path-ok" {
		t.Fatalf("profile PATH was not used: %+v", result)
	}
}
