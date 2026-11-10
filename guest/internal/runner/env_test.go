package runner

import "testing"

func TestBuildEnvProfileBeforeRequestOverrides(t *testing.T) {
	env := buildEnv(Options{
		Workspace: "/workspace",
		ProfileEnv: map[string]string{
			"PATH":       "/runtimes/python/bin:/usr/bin",
			"PYTHONHOME": "/runtimes/python",
			"LD_PRELOAD": "/tmp/ignored.so",
		},
	}, map[string]string{
		"PATH": "/custom/bin",
		"FOO":  "bar",
	})

	if got := envValue(env, "PATH"); got != "/custom/bin" {
		t.Fatalf("PATH = %q, want request override", got)
	}
	if got := envValue(env, "PYTHONHOME"); got != "/runtimes/python" {
		t.Fatalf("PYTHONHOME = %q", got)
	}
	if got := envValue(env, "FOO"); got != "bar" {
		t.Fatalf("FOO = %q", got)
	}
	if got := envValue(env, "LD_PRELOAD"); got != "" {
		t.Fatalf("LD_PRELOAD should not be applied, got %q", got)
	}
}

func envValue(env []string, key string) string {
	prefix := key + "="
	for _, entry := range env {
		if len(entry) >= len(prefix) && entry[:len(prefix)] == prefix {
			return entry[len(prefix):]
		}
	}
	return ""
}
