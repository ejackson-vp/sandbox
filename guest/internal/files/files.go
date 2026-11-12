// Package files implements workspace-confined file operations.
//
// Security properties:
//   - every path is resolved inside a single workspace root; absolute escapes,
//     "..", and symlinked parents are rejected,
//   - archive extraction refuses absolute paths, "..", symlinks, hardlinks,
//     device nodes and oversized members,
//   - writes happen with O_NOFOLLOW and the parent is re-validated after MkdirAll,
//   - a disk quota and per-file cap are enforced before writing.
//
// The workspace is a memory-backed emptyDir; nothing survives the pod.
package files

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"

	"github.com/x402s/sandbox/guest/internal/protocol"
)

type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func errf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

type Workspace struct {
	Root         string
	MaxFileBytes int64
	MaxDiskBytes int64
	MaxEntries   int
	// MaxArchiveEntries bounds inode/CPU abuse from tiny-member archives.
	MaxArchiveEntries int
}

func New(root string, maxFileBytes, maxDiskBytes int64) (*Workspace, error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(root, ".tmp"), 0o700); err != nil {
		return nil, err
	}
	// Canonicalise the root so that symlinked parents (for example /var ->
	// /private/var on macOS) do not look like an escape.
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	return &Workspace{
		Root:              canonical,
		MaxFileBytes:      maxFileBytes,
		MaxDiskBytes:      maxDiskBytes,
		MaxEntries:        5000,
		MaxArchiveEntries: 2000,
	}, nil
}

// Resolve maps a customer path into the workspace, rejecting escapes.
func (w *Workspace) Resolve(p string) (string, error) {
	if len(p) > 4096 {
		return "", errf("invalid_path", "path too long")
	}
	if strings.ContainsRune(p, 0) {
		return "", errf("invalid_path", "NUL byte in path")
	}
	if p == "" {
		p = "."
	}
	var abs string
	if filepath.IsAbs(p) {
		abs = filepath.Clean(p)
	} else {
		abs = filepath.Join(w.Root, p)
	}
	root := filepath.Clean(w.Root)
	if abs != root && !strings.HasPrefix(abs, root+string(os.PathSeparator)) {
		return "", errf("path_outside_workspace", "path escapes the workspace")
	}

	// Resolve symlinks on the deepest existing ancestor. This rejects a parent
	// directory that is a symlink pointing outside the workspace.
	existing := abs
	for {
		if _, err := os.Lstat(existing); err == nil {
			break
		}
		parent := filepath.Dir(existing)
		if parent == existing {
			break
		}
		existing = parent
	}
	real, err := filepath.EvalSymlinks(existing)
	if err != nil {
		return "", errf("invalid_path", "could not resolve path")
	}
	if real != root && !strings.HasPrefix(real, root+string(os.PathSeparator)) {
		return "", errf("symlink_escape", "path resolves outside the workspace")
	}
	return abs, nil
}

// Rel converts an absolute workspace path to the customer-visible relative form.
func (w *Workspace) Rel(abs string) string {
	rel, err := filepath.Rel(filepath.Clean(w.Root), abs)
	if err != nil || rel == "." {
		return "."
	}
	return rel
}

func (w *Workspace) Usage() (int64, error) {
	var total int64
	err := filepath.Walk(w.Root, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // best effort; unreadable entries are ignored
		}
		if info.Mode().IsRegular() {
			total += info.Size()
		}
		return nil
	})
	return total, err
}

func (w *Workspace) checkQuota(incoming int64) error {
	used, err := w.Usage()
	if err != nil {
		return errf("io_error", "could not measure workspace usage")
	}
	if used+incoming > w.MaxDiskBytes {
		return errf("quota_exceeded", "workspace quota exceeded (%d/%d bytes)", used+incoming, w.MaxDiskBytes)
	}
	return nil
}

// Put writes a file, or extracts a gzipped tar when archive is set.
func (w *Workspace) Put(p string, data []byte, mode os.FileMode, archive bool) (int64, int, error) {
	if int64(len(data)) > w.MaxFileBytes {
		return 0, 0, errf("file_too_large", "payload exceeds %d bytes", w.MaxFileBytes)
	}
	if archive {
		return w.extractTar(p, data)
	}

	abs, err := w.Resolve(p)
	if err != nil {
		return 0, 0, err
	}
	if abs == filepath.Clean(w.Root) {
		return 0, 0, errf("invalid_path", "cannot write to the workspace root")
	}
	if err := w.checkQuota(int64(len(data))); err != nil {
		return 0, 0, err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return 0, 0, errf("io_error", "could not create parent directory")
	}
	// Re-validate: MkdirAll may have traversed an attacker-created symlink.
	if _, err := w.Resolve(p); err != nil {
		return 0, 0, err
	}
	if info, err := os.Lstat(abs); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return 0, 0, errf("symlink_escape", "refusing to write through a symlink")
	}
	if mode == 0 {
		mode = 0o644
	}
	f, err := os.OpenFile(abs, os.O_CREATE|os.O_WRONLY|os.O_TRUNC|syscall.O_NOFOLLOW, mode&0o777)
	if err != nil {
		return 0, 0, errf("io_error", "could not open destination")
	}
	n, writeErr := f.Write(data)
	closeErr := f.Close()
	if writeErr != nil || closeErr != nil {
		return int64(n), 0, errf("io_error", "could not write file")
	}
	return int64(n), 1, nil
}

func (w *Workspace) Get(p string, archive bool) ([]byte, error) {
	abs, err := w.Resolve(p)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(abs)
	if err != nil {
		return nil, errf("not_found", "path does not exist")
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, errf("symlink_escape", "refusing to follow a symlink")
	}
	if archive || info.IsDir() {
		return w.tarPath(abs)
	}
	if !info.Mode().IsRegular() {
		return nil, errf("not_a_file", "path is not a regular file")
	}
	if info.Size() > w.MaxFileBytes {
		return nil, errf("file_too_large", "file exceeds %d bytes", w.MaxFileBytes)
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, errf("io_error", "could not read file")
	}
	return data, nil
}

func (w *Workspace) List(p string, recursive bool) ([]protocol.FileEntry, int64, error) {
	abs, err := w.Resolve(p)
	if err != nil {
		return nil, 0, err
	}
	info, err := os.Lstat(abs)
	if err != nil {
		return nil, 0, errf("not_found", "path does not exist")
	}
	if !info.IsDir() {
		return nil, 0, errf("not_a_directory", "path is not a directory")
	}
	entries := make([]protocol.FileEntry, 0, 32)
	var total int64
	collect := func(path string, fi os.FileInfo) {
		if len(entries) >= w.MaxEntries {
			return
		}
		rel, err := filepath.Rel(filepath.Clean(w.Root), path)
		if err != nil {
			return
		}
		entries = append(entries, protocol.FileEntry{
			Path:    filepath.ToSlash(rel),
			Size:    fi.Size(),
			Mode:    uint32(fi.Mode().Perm()),
			IsDir:   fi.IsDir(),
			MtimeMs: fi.ModTime().UnixMilli(),
		})
		if fi.Mode().IsRegular() {
			total += fi.Size()
		}
	}
	if recursive {
		_ = filepath.Walk(abs, func(path string, fi os.FileInfo, err error) error {
			if err != nil || path == abs {
				return nil
			}
			if fi.Mode()&os.ModeSymlink != 0 {
				return nil
			}
			collect(path, fi)
			return nil
		})
	} else {
		dirents, err := os.ReadDir(abs)
		if err != nil {
			return nil, 0, errf("io_error", "could not read directory")
		}
		for _, d := range dirents {
			fi, err := d.Info()
			if err != nil {
				continue
			}
			collect(filepath.Join(abs, d.Name()), fi)
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	return entries, total, nil
}

func (w *Workspace) Stat(p string) (*protocol.FileEntry, error) {
	abs, err := w.Resolve(p)
	if err != nil {
		return nil, err
	}
	fi, err := os.Lstat(abs)
	if err != nil {
		return nil, errf("not_found", "path does not exist")
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return nil, errf("symlink_escape", "refusing to follow a symlink")
	}
	rel, _ := filepath.Rel(filepath.Clean(w.Root), abs)
	if rel == "." {
		rel = "."
	}
	return &protocol.FileEntry{
		Path:    filepath.ToSlash(rel),
		Size:    fi.Size(),
		Mode:    uint32(fi.Mode().Perm()),
		IsDir:   fi.IsDir(),
		MtimeMs: fi.ModTime().UnixMilli(),
	}, nil
}
