package files

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Archive extraction is the only place a customer-supplied byte stream decides
// where bytes land, and CodeQL flags it as a zip-slip sink (go/zipslip). The
// guards exist; before this file nothing in the Go suite would fail if one was
// removed, because the TypeScript suites are the only gate that runs on every
// push. Every rejection below asserts the error code, so a guard that starts
// returning a different failure (or a success) is visible.

type tarEntry struct {
	name     string
	body     string
	typeflag byte
	linkname string
	mode     int64
}

func tarGz(t *testing.T, entries []tarEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		typeflag := e.typeflag
		if typeflag == 0 {
			typeflag = tar.TypeReg
		}
		hdr := &tar.Header{
			Name:     e.name,
			Typeflag: typeflag,
			Linkname: e.linkname,
			Mode:     e.mode,
		}
		if typeflag == tar.TypeReg {
			hdr.Size = int64(len(e.body))
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatalf("write header %q: %v", e.name, err)
		}
		if typeflag == tar.TypeReg {
			if _, err := tw.Write([]byte(e.body)); err != nil {
				t.Fatalf("write body %q: %v", e.name, err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("close tar: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("close gzip: %v", err)
	}
	return buf.Bytes()
}

// newArchiveWorkspace puts the workspace one level below a temp root, so a test
// can prove a rejected member did not land beside the workspace either.
func newArchiveWorkspace(t *testing.T, maxFileBytes, maxDiskBytes int64) (*Workspace, string) {
	t.Helper()
	parent := t.TempDir()
	root := filepath.Join(parent, "workspace")
	ws, err := New(root, maxFileBytes, maxDiskBytes)
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	return ws, parent
}

// wantCode fails unless err is a workspace error with the given code.
func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected %s, got no error", code)
	}
	var werr *Error
	if !errors.As(err, &werr) {
		t.Fatalf("expected a workspace error with code %s, got %T: %v", code, err, err)
	}
	if werr.Code != code {
		t.Fatalf("expected code %s, got %s: %v", code, werr.Code, err)
	}
}

// nothingNamed walks the temp root, including the workspace, and fails if any
// path's base name matches one the archive must never create.
func nothingNamed(t *testing.T, root string, names ...string) {
	t.Helper()
	banned := make(map[string]bool, len(names))
	for _, name := range names {
		banned[name] = true
	}
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if banned[info.Name()] {
			t.Fatalf("archive created %q at %q", info.Name(), path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
}

func TestArchiveRejectsUnsafeEntries(t *testing.T) {
	cases := []struct {
		name    string
		entries []tarEntry
		code    string
		banned  []string
	}{
		{
			name:    "parent traversal",
			entries: []tarEntry{{name: "../escape.txt", body: "pwned"}},
			code:    "unsafe_archive",
			banned:  []string{"escape.txt"},
		},
		{
			name:    "dot dot only",
			entries: []tarEntry{{name: "..", body: ""}},
			code:    "unsafe_archive",
		},
		{
			name:    "nested traversal",
			entries: []tarEntry{{name: "a/b/../../../escape.txt", body: "pwned"}},
			code:    "unsafe_archive",
			banned:  []string{"escape.txt"},
		},
		{
			name:    "absolute path",
			entries: []tarEntry{{name: "/etc/passwd", body: "root:x:0:0"}},
			code:    "unsafe_archive",
		},
		{
			name:    "absolute traversal",
			entries: []tarEntry{{name: "/workspace/../../etc/shadow", body: "x"}},
			code:    "unsafe_archive",
		},
		{
			name:    "symlink entry",
			entries: []tarEntry{{name: "link", typeflag: tar.TypeSymlink, linkname: "/etc/passwd"}},
			code:    "unsafe_archive",
			banned:  []string{"link"},
		},
		{
			name:    "hardlink entry",
			entries: []tarEntry{{name: "hard", typeflag: tar.TypeLink, linkname: "/etc/passwd"}},
			code:    "unsafe_archive",
			banned:  []string{"hard"},
		},
		{
			name:    "character device",
			entries: []tarEntry{{name: "chardev", typeflag: tar.TypeChar}},
			code:    "unsafe_archive",
			banned:  []string{"chardev"},
		},
		{
			name:    "block device",
			entries: []tarEntry{{name: "blockdev", typeflag: tar.TypeBlock}},
			code:    "unsafe_archive",
			banned:  []string{"blockdev"},
		},
		{
			name:    "fifo",
			entries: []tarEntry{{name: "fifo", typeflag: tar.TypeFifo}},
			code:    "unsafe_archive",
			banned:  []string{"fifo"},
		},
		{
			// A traversal entry after a legitimate one must abort the whole
			// extraction, not just skip the bad member.
			name: "traversal after a good entry",
			entries: []tarEntry{
				{name: "good.txt", body: "ok"},
				{name: "../escape.txt", body: "pwned"},
			},
			code:   "unsafe_archive",
			banned: []string{"escape.txt"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ws, parent := newArchiveWorkspace(t, 1<<20, 8<<20)
			_, _, err := ws.Put("incoming", tarGz(t, tc.entries), 0, true)
			wantCode(t, err, tc.code)
			nothingNamed(t, parent, tc.banned...)
		})
	}
}

func TestArchiveEnforcesEntryCountCap(t *testing.T) {
	ws, parent := newArchiveWorkspace(t, 1<<20, 8<<20)
	ws.MaxArchiveEntries = 2

	archive := tarGz(t, []tarEntry{
		{name: "one.txt", body: "1"},
		{name: "two.txt", body: "2"},
		{name: "three.txt", body: "3"},
	})

	_, files, err := ws.Put("incoming", archive, 0, true)
	wantCode(t, err, "invalid_archive")
	if files != 3 {
		t.Fatalf("expected the over-cap entry to be counted, got %d entries", files)
	}
	nothingNamed(t, parent, "three.txt")
}

func TestArchiveEnforcesExpansionCaps(t *testing.T) {
	t.Run("member larger than the per-file cap", func(t *testing.T) {
		ws, _ := newArchiveWorkspace(t, 8, 8<<20)
		archive := tarGz(t, []tarEntry{{name: "big.bin", body: strings.Repeat("a", 16)}})
		_, _, err := ws.Put("incoming", archive, 0, true)
		wantCode(t, err, "file_too_large")
	})

	t.Run("members whose declared sizes exceed the per-file cap", func(t *testing.T) {
		// Each member is under the cap; the sum is not. This is the shape that
		// bypasses a per-member check.
		ws, _ := newArchiveWorkspace(t, 8, 8<<20)
		archive := tarGz(t, []tarEntry{
			{name: "a.bin", body: "aaaaaaaa"},
			{name: "b.bin", body: "bbbbbbbb"},
		})
		_, _, err := ws.Put("incoming", archive, 0, true)
		wantCode(t, err, "file_too_large")
	})

	t.Run("staging-file path applies the same cap", func(t *testing.T) {
		ws, _ := newArchiveWorkspace(t, 8, 8<<20)
		archive := tarGz(t, []tarEntry{{name: "big.bin", body: strings.Repeat("a", 16)}})
		staging := filepath.Join(t.TempDir(), "archive.tgz")
		if err := os.WriteFile(staging, archive, 0o600); err != nil {
			t.Fatalf("write staging archive: %v", err)
		}
		_, _, err := ws.ExtractTarFile("incoming", staging)
		wantCode(t, err, "file_too_large")
	})

	t.Run("workspace quota", func(t *testing.T) {
		ws, _ := newArchiveWorkspace(t, 1<<20, 4)
		archive := tarGz(t, []tarEntry{{name: "small.txt", body: "abcde"}})
		_, _, err := ws.Put("incoming", archive, 0, true)
		wantCode(t, err, "quota_exceeded")
	})
}

func TestArchiveExtractsNestedTree(t *testing.T) {
	ws, _ := newArchiveWorkspace(t, 1<<20, 8<<20)
	archive := tarGz(t, []tarEntry{
		{name: "tree/", typeflag: tar.TypeDir, mode: 0o755},
		{name: "tree/a/", typeflag: tar.TypeDir, mode: 0o755},
		{name: "tree/a/one.txt", body: "one\n", mode: 0o644},
		{name: "tree/two.txt", body: "two\n", mode: 0o644},
	})

	total, files, err := ws.Put("restored", archive, 0, true)
	if err != nil {
		t.Fatalf("extract nested archive: %v", err)
	}
	if files != 4 {
		t.Fatalf("expected 4 entries, got %d", files)
	}
	if want := int64(len("one\n") + len("two\n")); total != want {
		t.Fatalf("expected %d bytes written, got %d", want, total)
	}
	extracted := map[string]string{
		filepath.Join("restored", "tree", "a", "one.txt"): "one\n",
		filepath.Join("restored", "tree", "two.txt"):      "two\n",
	}
	for rel, want := range extracted {
		got, readErr := os.ReadFile(filepath.Join(ws.Root, rel))
		if readErr != nil {
			t.Fatalf("read %s: %v", rel, readErr)
		}
		if string(got) != want {
			t.Fatalf("%s: expected %q, got %q", rel, want, got)
		}
	}
}

// The two entry points must share one rule set: a guard added to the in-memory
// path only would leave the staging-file path (used for real transfers) open.
func TestArchiveFileRejectsTraversal(t *testing.T) {
	ws, parent := newArchiveWorkspace(t, 1<<20, 8<<20)
	staging := filepath.Join(t.TempDir(), "archive.tgz")
	if err := os.WriteFile(staging, tarGz(t, []tarEntry{{name: "../escape.txt", body: "pwned"}}), 0o600); err != nil {
		t.Fatalf("write staging archive: %v", err)
	}
	_, _, err := ws.ExtractTarFile("incoming", staging)
	wantCode(t, err, "unsafe_archive")
	nothingNamed(t, parent, "escape.txt")
}
