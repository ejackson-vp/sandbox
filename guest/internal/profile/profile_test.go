package profile

import (
	"os"
	"path/filepath"
	"testing"
)

func writeProfile(t *testing.T, root, name, body string) {
	t.Helper()
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "profile.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoad(t *testing.T) {
	root := t.TempDir()
	writeProfile(t, root, "python", `{
		"name": "python",
		"version": "3.12",
		"env": {"PATH": "/runtimes/python/bin:/usr/bin", "PYTHONHOME": "/runtimes/python"},
		"commands": ["python3"]
	}`)

	manifest, err := Load(root, "python")
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Name != "python" || manifest.Env["PYTHONHOME"] != "/runtimes/python" {
		t.Fatalf("unexpected manifest: %+v", manifest)
	}
}

func TestLoadRejectsUnsafeInput(t *testing.T) {
	root := t.TempDir()
	cases := []struct {
		name string
		body string
	}{
		{"missing-path", `{"name":"missing-path","env":{}}`},
		{"bad-key", `{"name":"bad-key","env":{"PATH":"/bin","PATH;rm":"x"}}`},
		{"preload", `{"name":"preload","env":{"PATH":"/bin","LD_PRELOAD":"/tmp/x.so"}}`},
		{"wrong-name", `{"name":"other","env":{"PATH":"/bin"}}`},
		{"bad-command", `{"name":"bad-command","env":{"PATH":"/bin"},"commands":[""]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			writeProfile(t, root, tc.name, tc.body)
			if _, err := Load(root, tc.name); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestLoadRejectsTraversal(t *testing.T) {
	if _, err := Load(t.TempDir(), "../etc"); err == nil {
		t.Fatal("expected invalid profile name")
	}
}
