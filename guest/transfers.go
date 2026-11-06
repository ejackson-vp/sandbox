package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"syscall"
	"time"

	"github.com/x402s/sandbox/guest/internal/files"
	"github.com/x402s/sandbox/guest/internal/protocol"
)

const (
	transferTTL        = 10 * time.Minute
	maxTransferChunk   = 4 * 1024 * 1024
	maxConcurrentXfers = 4
	transferStagingDir = ".tmp/xfers"
	transferIDPattern  = `^[A-Za-z0-9_-]{8,64}$`
)

var transferIDRe = regexp.MustCompile(transferIDPattern)

type transfer struct {
	id         string
	direction  string
	path       string
	staging    string
	file       *os.File
	digest     hash.Hash
	bytes      int64
	size       int64
	archive    bool
	state      string
	sourceSize int64
	sourceMod  int64
	createdAt  time.Time
	lastUsed   time.Time
}

type transferManager struct {
	mu        sync.Mutex
	items     map[string]*transfer
	workspace *files.Workspace
	maxBytes  int64
	maxActive int
}

func newTransferManager(workspace *files.Workspace, maxBytes int64) *transferManager {
	return &transferManager{
		items:     map[string]*transfer{},
		workspace: workspace,
		maxBytes:  maxBytes,
		maxActive: maxConcurrentXfers,
	}
}

func (m *transferManager) error(req *protocol.Request, code, message string) *protocol.Result {
	return protocol.ErrorResult(req, code, message)
}

func (m *transferManager) pruneLocked(now time.Time) {
	for id, x := range m.items {
		if now.Sub(x.lastUsed) <= transferTTL {
			continue
		}
		x.state = "EXPIRED"
		_ = x.file.Close()
		if x.staging != "" {
			_ = os.Remove(x.staging)
		}
		delete(m.items, id)
	}
}

func (m *transferManager) result(req *protocol.Request, x *transfer) *protocol.Result {
	state := x.state
	if state == "" {
		state = "TRANSFERRING"
	}
	return &protocol.Result{
		V: 2, SessionID: req.SessionID, ClientNonce: req.ClientNonce, RequestID: req.RequestID,
		Op: req.Op, OK: true, TransferID: x.id, Direction: x.direction,
		State: state, CommittedBytes: x.bytes, Size: x.size,
		Digest: hex.EncodeToString(x.digest.Sum(nil)),
	}
}

func (m *transferManager) stagingPath(id string) string {
	return filepath.Join(m.workspace.Root, transferStagingDir, id)
}

func (m *transferManager) init(req *protocol.Request) *protocol.Result {
	if !transferIDRe.MatchString(req.TransferID) {
		return m.error(req, "invalid_transfer_id", "transferId must match [A-Za-z0-9_-]{8,64}")
	}
	if req.Direction != "upload" && req.Direction != "download" {
		return m.error(req, "invalid_direction", "direction must be upload or download")
	}
	if req.ChunkSize < 64*1024 || req.ChunkSize > maxTransferChunk {
		return m.error(req, "invalid_chunk_size", "chunkSize must be between 64 KiB and 4 MiB")
	}
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneLocked(now)
	if existing := m.items[req.TransferID]; existing != nil {
		if existing.direction != req.Direction || existing.path != req.Path {
			return m.error(req, "transfer_mismatch", "transfer id already belongs to a different transfer")
		}
		existing.lastUsed = now
		return m.result(req, existing)
	}
	if len(m.items) >= m.maxActive {
		return m.error(req, "too_many_transfers", "too many concurrent transfers")
	}
	if req.Direction == "upload" {
		for _, other := range m.items {
			if other.direction == "upload" && other.path == req.Path {
				return m.error(req, "path_busy", "another upload is already targeting this path")
			}
		}
	}
	abs, err := m.workspace.Resolve(req.Path)
	if err != nil {
		return m.error(req, "invalid_path", err.Error())
	}
	if abs == filepath.Clean(m.workspace.Root) {
		return m.error(req, "invalid_path", "cannot transfer to the workspace root")
	}

	if req.Direction == "upload" {
		if req.Size < 0 || req.Size > m.maxBytes {
			return m.error(req, "transfer_too_large", fmt.Sprintf("transfer exceeds %d bytes", m.maxBytes))
		}
		used, err := m.workspace.Usage()
		if err != nil {
			return m.error(req, "io_error", "could not measure workspace usage")
		}
		if used+req.Size > m.workspace.MaxDiskBytes {
			return m.error(req, "quota_exceeded", "workspace quota would be exceeded")
		}
		staging := m.stagingPath(req.TransferID)
		if err := os.MkdirAll(filepath.Dir(staging), 0o700); err != nil {
			return m.error(req, "io_error", "could not create transfer staging directory")
		}
		file, err := os.OpenFile(staging, os.O_CREATE|os.O_EXCL|os.O_WRONLY|syscall.O_NOFOLLOW, 0o600)
		if err != nil {
			if errors.Is(err, os.ErrExist) {
				return m.error(req, "transfer_exists", "transfer staging file already exists")
			}
			return m.error(req, "io_error", "could not create transfer staging file")
		}
		x := &transfer{
			id: req.TransferID, direction: req.Direction, path: req.Path, staging: staging,
			file: file, digest: sha256.New(), size: req.Size, archive: req.Archive,
			state: "TRANSFERRING", createdAt: now, lastUsed: now,
		}
		m.items[x.id] = x
		return m.result(req, x)
	}

	info, err := os.Lstat(abs)
	if err != nil {
		return m.error(req, "not_found", "source does not exist")
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return m.error(req, "symlink_escape", "refusing to read a symlink")
	}
	staging := m.stagingPath(req.TransferID) + ".tar.gz"
	sourcePath := abs
	sourceSize := info.Size()
	sourceMod := info.ModTime().UnixNano()
	if req.Archive {
		if err := os.MkdirAll(filepath.Dir(staging), 0o700); err != nil {
			return m.error(req, "io_error", "could not create archive staging directory")
		}
		if _, err := m.workspace.TarToFile(req.Path, staging); err != nil {
			return m.error(req, "archive_failed", err.Error())
		}
		stagingInfo, statErr := os.Stat(staging)
		if statErr != nil {
			return m.error(req, "io_error", "could not stat transfer archive")
		}
		sourcePath, sourceSize, sourceMod = staging, stagingInfo.Size(), stagingInfo.ModTime().UnixNano()
	} else if !info.Mode().IsRegular() {
		return m.error(req, "not_a_file", "source is not a regular file")
	}
	if sourceSize > m.maxBytes {
		_ = os.Remove(staging)
		return m.error(req, "transfer_too_large", fmt.Sprintf("source exceeds %d bytes", m.maxBytes))
	}
	file, err := os.OpenFile(sourcePath, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		_ = os.Remove(staging)
		return m.error(req, "io_error", "could not open source")
	}
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		_ = file.Close()
		_ = os.Remove(staging)
		return m.error(req, "io_error", "could not hash source")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		_ = file.Close()
		_ = os.Remove(staging)
		return m.error(req, "io_error", "could not rewind source")
	}
	x := &transfer{
		id: req.TransferID, direction: req.Direction, path: req.Path, staging: staging,
		file: file, digest: digest, size: sourceSize, archive: req.Archive, state: "TRANSFERRING",
		sourceSize: sourceSize, sourceMod: sourceMod, createdAt: now, lastUsed: now,
	}
	m.items[x.id] = x
	return m.result(req, x)
}

func (m *transferManager) chunk(req *protocol.Request) *protocol.Result {
	m.mu.Lock()
	defer m.mu.Unlock()
	x := m.items[req.TransferID]
	if x == nil {
		return m.error(req, "transfer_not_found", "transfer does not exist")
	}
	if x.direction != "upload" || x.state != "TRANSFERRING" {
		return m.error(req, "invalid_transfer_state", "transfer is not accepting upload chunks")
	}
	x.lastUsed = time.Now()
	data, err := base64.StdEncoding.DecodeString(req.DataBase64)
	if err != nil {
		return m.error(req, "invalid_chunk", "chunk is not valid base64")
	}
	if int64(len(data)) == 0 || int64(len(data)) > maxTransferChunk {
		return m.error(req, "invalid_chunk_size", "chunk is empty or too large")
	}
	if req.Offset < x.bytes && req.Offset+int64(len(data)) <= x.bytes {
		// Duplicate delivery of an already committed chunk. The final digest
		// and size still decide success; acknowledge without writing.
		x.lastUsed = time.Now()
		return m.result(req, x)
	}
	if req.Offset != x.bytes {
		return m.error(req, "out_of_order", fmt.Sprintf("expected offset %d, got %d", x.bytes, req.Offset))
	}
	if x.bytes+int64(len(data)) > x.size {
		return m.error(req, "transfer_too_large", "chunk exceeds declared transfer size")
	}
	if _, err := x.file.Write(data); err != nil {
		return m.error(req, "io_error", "could not write transfer chunk")
	}
	_, _ = x.digest.Write(data)
	x.bytes += int64(len(data))
	return m.result(req, x)
}

func (m *transferManager) complete(req *protocol.Request) *protocol.Result {
	m.mu.Lock()
	defer m.mu.Unlock()
	x := m.items[req.TransferID]
	if x == nil {
		return m.error(req, "transfer_not_found", "transfer does not exist")
	}
	if x.direction != "upload" {
		return m.error(req, "invalid_transfer_state", "not an upload transfer")
	}
	x.lastUsed = time.Now()
	x.state = "VERIFYING"
	if x.bytes != req.Size || req.Size != x.size {
		x.state = "FAILED"
		_ = x.file.Close()
		_ = os.Remove(x.staging)
		delete(m.items, x.id)
		return m.error(req, "size_mismatch", "received size does not match declared size")
	}
	actual := hex.EncodeToString(x.digest.Sum(nil))
	if req.Digest == "" || actual != req.Digest {
		x.state = "FAILED"
		_ = x.file.Close()
		_ = os.Remove(x.staging)
		delete(m.items, x.id)
		return m.error(req, "integrity_failed", "final SHA-256 does not match")
	}
	if err := x.file.Sync(); err != nil {
		return m.error(req, "io_error", "could not flush transfer")
	}
	if err := x.file.Close(); err != nil {
		return m.error(req, "io_error", "could not close transfer")
	}
	dest, err := m.workspace.Resolve(x.path)
	if err != nil {
		_ = os.Remove(x.staging)
		delete(m.items, x.id)
		return m.error(req, "invalid_path", err.Error())
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return m.error(req, "io_error", "could not create destination directory")
	}
	if _, err := m.workspace.Resolve(x.path); err != nil {
		return m.error(req, "invalid_path", err.Error())
	}
	if info, err := os.Lstat(dest); err == nil && info.IsDir() {
		return m.error(req, "invalid_path", "destination is a directory")
	}
	if x.archive {
		tmpDir := x.staging + ".dir"
		if err := os.MkdirAll(tmpDir, 0o700); err != nil {
			return m.error(req, "io_error", "could not create archive extraction directory")
		}
		if _, _, extractErr := m.workspace.ExtractTarFile(tmpDir, x.staging); extractErr != nil {
			_ = os.RemoveAll(tmpDir)
			_ = os.Remove(x.staging)
			delete(m.items, x.id)
			return m.error(req, "archive_rejected", extractErr.Error())
		}
		if _, statErr := os.Lstat(dest); statErr == nil {
			_ = os.RemoveAll(tmpDir)
			_ = os.Remove(x.staging)
			delete(m.items, x.id)
			return m.error(req, "destination_exists", "archive destination already exists")
		}
		if err := os.Rename(tmpDir, dest); err != nil {
			_ = os.RemoveAll(tmpDir)
			return m.error(req, "io_error", "could not publish archive")
		}
		_ = os.Remove(x.staging)
	} else if err := os.Rename(x.staging, dest); err != nil {
		return m.error(req, "io_error", "could not publish transfer")
	}
	x.state = "COMPLETED"
	x.bytes = req.Size
	res := m.result(req, x)
	delete(m.items, x.id)
	return res
}

func (m *transferManager) status(req *protocol.Request) *protocol.Result {
	m.mu.Lock()
	defer m.mu.Unlock()
	x := m.items[req.TransferID]
	if x == nil {
		return m.error(req, "transfer_not_found", "transfer does not exist")
	}
	x.lastUsed = time.Now()
	return m.result(req, x)
}

func (m *transferManager) read(req *protocol.Request) *protocol.Result {
	m.mu.Lock()
	defer m.mu.Unlock()
	x := m.items[req.TransferID]
	if x == nil {
		return m.error(req, "transfer_not_found", "transfer does not exist")
	}
	if x.direction != "download" || x.state != "TRANSFERRING" {
		return m.error(req, "invalid_transfer_state", "transfer is not readable")
	}
	info, err := x.file.Stat()
	if err != nil || info.Size() != x.sourceSize || info.ModTime().UnixNano() != x.sourceMod {
		_ = x.file.Close()
		_ = os.Remove(x.staging)
		delete(m.items, x.id)
		return m.error(req, "source_changed", "source file changed during transfer")
	}
	if req.Offset != x.bytes {
		return m.error(req, "out_of_order", fmt.Sprintf("expected offset %d, got %d", x.bytes, req.Offset))
	}
	if req.MaxBytes <= 0 || req.MaxBytes > maxTransferChunk {
		return m.error(req, "invalid_chunk_size", "maxBytes must be between 1 and 4 MiB")
	}
	buf := make([]byte, req.MaxBytes)
	n, readErr := x.file.Read(buf)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return m.error(req, "io_error", "could not read transfer chunk")
	}
	buf = buf[:n]
	x.bytes += int64(n)
	x.lastUsed = time.Now()
	res := m.result(req, x)
	res.ChunkBase64 = base64.StdEncoding.EncodeToString(buf)
	res.CommittedBytes = x.bytes
	res.Done = x.bytes >= x.size
	if res.Done {
		x.state = "COMPLETED"
		_ = x.file.Close()
		if x.staging != "" {
			_ = os.Remove(x.staging)
		}
		delete(m.items, x.id)
	}
	return res
}

func (m *transferManager) cancel(req *protocol.Request) *protocol.Result {
	m.mu.Lock()
	defer m.mu.Unlock()
	x := m.items[req.TransferID]
	if x == nil {
		return m.error(req, "transfer_not_found", "transfer does not exist")
	}
	x.state = "CANCELLED"
	_ = x.file.Close()
	if x.staging != "" {
		_ = os.Remove(x.staging)
	}
	res := m.result(req, x)
	delete(m.items, req.TransferID)
	return res
}

func (m *transferManager) shutdown() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, x := range m.items {
		_ = x.file.Close()
		if x.staging != "" {
			_ = os.Remove(x.staging)
		}
	}
	m.items = map[string]*transfer{}
}
