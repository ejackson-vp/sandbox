package files

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// FuzzResolve drives workspace path validation. Resolve is the only gate
// between a customer-supplied path and the filesystem, so it must reject or
// contain every input: no panic, and every accepted path stays inside the
// workspace root even after symlink resolution.
//
// Seeds mirror the cases in the unit tests and the shapes seen in the wild:
// relative paths, traversal, absolute host paths, NUL bytes, and a path at the
// 4096-byte limit.
func FuzzResolve(f *testing.F) {
	root := f.TempDir()
	ws, err := New(root, 1<<20, 8<<20)
	if err != nil {
		f.Fatalf("create workspace: %v", err)
	}
	f.Add(".")
	f.Add("a/b/c.txt")
	f.Add("../escape")
	f.Add("a/../../b")
	f.Add("/etc/passwd")
	f.Add("/workspace/../../etc/shadow")
	f.Add("nul\x00byte")
	f.Add(strings.Repeat("a", 4097))
	f.Add(".tmp/xfers/transfer-1")

	f.Fuzz(func(t *testing.T, p string) {
		abs, err := ws.Resolve(p)
		if err != nil {
			if abs != "" {
				t.Fatalf("Resolve returned a path with an error: %q", abs)
			}
			return
		}
		cleanRoot := filepath.Clean(ws.Root)
		if abs != cleanRoot && !strings.HasPrefix(abs, cleanRoot+string(os.PathSeparator)) {
			t.Fatalf("Resolve(%q) escaped the workspace: %q not under %q", p, abs, cleanRoot)
		}
	})
}
