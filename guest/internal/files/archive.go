package files

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

func (w *Workspace) extractTar(p string, data []byte) (int64, int, error) {
	return w.extractTarReader(p, bytes.NewReader(data))
}

// ExtractTarFile extracts a gzip tar from an on-disk staging file with the same
// path, link, member-size and expansion rules as the in-memory path.
func (w *Workspace) ExtractTarFile(p, archivePath string) (int64, int, error) {
	file, err := os.Open(archivePath)
	if err != nil {
		return 0, 0, errf("io_error", "could not open transfer archive")
	}
	defer file.Close()
	return w.extractTarReader(p, file)
}

func (w *Workspace) extractTarReader(p string, reader io.Reader) (int64, int, error) {
	target, err := w.Resolve(p)
	if err != nil {
		return 0, 0, err
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		return 0, 0, errf("io_error", "could not create target directory")
	}
	if _, err := w.Resolve(p); err != nil {
		return 0, 0, err
	}

	gz, err := gzip.NewReader(reader)
	if err != nil {
		return 0, 0, errf("invalid_archive", "not a gzip archive")
	}
	defer gz.Close()
	tr := tar.NewReader(gz)

	used, _ := w.Usage()
	var total int64
	files := 0
	var declared int64
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return 0, 0, errf("invalid_archive", "could not read archive")
		}
		name := filepath.Clean(hdr.Name)
		if name == "." {
			continue
		}
		if filepath.IsAbs(hdr.Name) || name == ".." || strings.HasPrefix(name, ".."+string(os.PathSeparator)) {
			return 0, 0, errf("unsafe_archive", "archive member escapes the workspace: %q", hdr.Name)
		}
		files++
		if files > w.MaxArchiveEntries {
			return total, files, errf("invalid_archive", "archive contains too many entries")
		}
		switch hdr.Typeflag {
		case tar.TypeReg, tar.TypeDir:
		case tar.TypeXGlobalHeader, tar.TypeXHeader:
			continue
		default:
			return 0, 0, errf("unsafe_archive", "archive contains an unsupported entry type")
		}
		if hdr.Size < 0 || hdr.Size > w.MaxFileBytes {
			return 0, 0, errf("file_too_large", "archive member exceeds %d bytes", w.MaxFileBytes)
		}
		declared += hdr.Size
		if declared > w.MaxFileBytes {
			return total, files, errf("file_too_large", "archive expands beyond %d bytes", w.MaxFileBytes)
		}

		dest := filepath.Join(target, name)
		root := filepath.Clean(w.Root)
		if dest != root && !strings.HasPrefix(dest, root+string(os.PathSeparator)) {
			return 0, 0, errf("unsafe_archive", "archive member escapes the workspace: %q", hdr.Name)
		}
		if _, err := w.Resolve(w.Rel(dest)); err != nil {
			return 0, 0, err
		}

		if hdr.Typeflag == tar.TypeDir {
			if err := os.MkdirAll(dest, 0o755); err != nil {
				return 0, 0, errf("io_error", "could not create directory from archive")
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return 0, 0, errf("io_error", "could not create directory from archive")
		}
		if info, err := os.Lstat(dest); err == nil && info.Mode()&os.ModeSymlink != 0 {
			return 0, 0, errf("symlink_escape", "archive would write through a symlink")
		}
		mode := os.FileMode(hdr.Mode & 0o777)
		if mode == 0 {
			mode = 0o644
		}
		f, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC|syscall.O_NOFOLLOW, mode)
		if err != nil {
			return 0, 0, errf("io_error", "could not create file from archive")
		}
		n, copyErr := io.Copy(f, io.LimitReader(tr, w.MaxFileBytes+1))
		closeErr := f.Close()
		if copyErr != nil || closeErr != nil {
			return total, files, errf("io_error", "could not write file from archive")
		}
		total += n
		if total > w.MaxFileBytes {
			return total, files, errf("file_too_large", "archive expands beyond %d bytes", w.MaxFileBytes)
		}
		if used+total > w.MaxDiskBytes {
			return total, files, errf("quota_exceeded", "workspace quota exceeded (%d/%d bytes)", used+total, w.MaxDiskBytes)
		}
	}
	return total, files, nil
}

// Get returns file contents, or a gzipped tar when archive is set.

func (w *Workspace) tarPath(abs string) ([]byte, error) {
	info, err := os.Lstat(abs)
	if err != nil {
		return nil, errf("not_found", "path does not exist")
	}
	base := filepath.Dir(abs)
	if info.IsDir() {
		base = filepath.Dir(abs)
	}
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	var total int64
	walkErr := filepath.Walk(abs, func(path string, fi os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			return nil // never export symlinks
		}
		if !fi.Mode().IsRegular() && !fi.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(base, path)
		if err != nil {
			return nil
		}
		hdr, err := tar.FileInfoHeader(fi, "")
		if err != nil {
			return nil
		}
		hdr.Name = filepath.ToSlash(rel)
		hdr.Uid, hdr.Gid = 0, 0
		hdr.Uname, hdr.Gname = "", ""
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if fi.Mode().IsRegular() {
			total += fi.Size()
			if total > w.MaxDiskBytes {
				return errf("quota_exceeded", "archive would exceed workspace quota")
			}
			f, err := os.Open(path)
			if err != nil {
				return nil
			}
			_, copyErr := io.Copy(tw, io.LimitReader(f, fi.Size()))
			_ = f.Close()
			return copyErr
		}
		return nil
	})
	if walkErr != nil {
		return nil, errf("io_error", "could not build archive")
	}
	if err := tw.Close(); err != nil {
		return nil, errf("io_error", "could not finish archive")
	}
	if err := gz.Close(); err != nil {
		return nil, errf("io_error", "could not finish archive")
	}
	return buf.Bytes(), nil
}

// TarToFile streams a gzipped tar of a workspace path to an existing staging
// file. It never buffers the archive in memory.
func (w *Workspace) TarToFile(p, outPath string) (int64, error) {
	abs, err := w.Resolve(p)
	if err != nil {
		return 0, err
	}
	info, err := os.Lstat(abs)
	if err != nil {
		return 0, errf("not_found", "path does not exist")
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return 0, errf("symlink_escape", "refusing to archive a symlink")
	}
	out, err := os.OpenFile(outPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return 0, errf("io_error", "could not create transfer archive")
	}
	gz := gzip.NewWriter(out)
	tw := tar.NewWriter(gz)
	base := filepath.Dir(abs)
	if info.IsDir() {
		base = abs
	}
	var total int64
	walkErr := filepath.Walk(abs, func(path string, fi os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		if !fi.Mode().IsRegular() && !fi.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(base, path)
		if err != nil {
			return nil
		}
		hdr, err := tar.FileInfoHeader(fi, "")
		if err != nil {
			return nil
		}
		hdr.Name = filepath.ToSlash(rel)
		hdr.Uid, hdr.Gid = 0, 0
		hdr.Uname, hdr.Gname = "", ""
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if fi.Mode().IsRegular() {
			total += fi.Size()
			if total > w.MaxDiskBytes {
				return errf("quota_exceeded", "archive would exceed workspace quota")
			}
			f, err := os.Open(path)
			if err != nil {
				return nil
			}
			_, copyErr := io.Copy(tw, io.LimitReader(f, fi.Size()))
			_ = f.Close()
			return copyErr
		}
		return nil
	})
	if walkErr != nil {
		_ = out.Close()
		_ = os.Remove(outPath)
		return 0, errf("io_error", "could not build archive")
	}
	if err := tw.Close(); err != nil {
		_ = out.Close()
		return 0, errf("io_error", "could not finish archive")
	}
	if err := gz.Close(); err != nil {
		_ = out.Close()
		return 0, errf("io_error", "could not finish archive")
	}
	if err := out.Close(); err != nil {
		return 0, errf("io_error", "could not close archive")
	}
	return total, nil
}
