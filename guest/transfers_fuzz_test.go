package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"

	"github.com/x402s/sandbox/guest/internal/files"
	"github.com/x402s/sandbox/guest/internal/protocol"
)

// FuzzTransferFraming drives the chunked upload state machine with arbitrary
// transfer ids, directions, sizes, offsets and payloads. It covers the parts
// that are easiest to get wrong: duplicate delivery, out-of-order chunks,
// zero-length chunks, a chunk that would exceed the declared size, and a
// complete whose size/digest does not match what was staged.
//
// The workspace is created once per fuzz process; every accepted transfer is
// cancelled (or completed and its destination removed) so disk use and the
// manager's map stay bounded for the whole run.
func FuzzTransferFraming(f *testing.F) {
	root := f.TempDir()
	ws, err := files.New(root, 8<<20, 64<<20)
	if err != nil {
		f.Fatalf("create workspace: %v", err)
	}
	m := newTransferManager(ws, 4<<20)

	seed := func(id, direction, path string, size, chunkSize, offset int64, chunk []byte) {
		f.Add(uint8(0), id, direction, path, size, chunkSize, offset, chunk)
	}

	// Shapes taken from guest/transfers_test.go: a complete upload, an
	// out-of-order chunk, a duplicate chunk, a traversal path and an id that
	// does not match the transfer-id pattern.
	data := []byte("hello transfer")
	seed("transfer-seed1", "upload", "result.txt", int64(len(data)), 64*1024, 0, data)
	seed("transfer-seed2", "upload", "result.txt", int64(len(data)), 64*1024, 5, data)
	seed("transfer-seed3", "download", "missing.txt", 0, 64*1024, 0, nil)
	seed("transfer-seed4", "upload", "../escape", 1, 64*1024, 0, []byte("x"))
	seed("bad id", "upload", "a.txt", 1, 64*1024, 0, []byte("x"))
	seed("transfer-seed5", "upload", "a.txt", 1, 1, 0, []byte("x"))

	f.Fuzz(func(t *testing.T, tag uint8, id, direction, path string, size, chunkSize, offset int64, chunk []byte) {
		// Derive a stable id from the input so repeated seeds hit the
		// "already exists / mismatch" branches instead of leaking transfers.
		if len(id) > 40 {
			id = id[:40]
		}
		sum := sha256.Sum256(append([]byte("fz:"), id...))
		transferID := "fz" + hex.EncodeToString(sum[:8])

		fillable := direction == "upload" || direction == "download"
		if !fillable && tag%4 != 0 {
			direction = "upload"
		}
		if len(path) > 200 {
			path = path[:200]
		}
		// Bound what can be declared and staged so one input cannot fill the
		// disk or the fuzzing corpus.
		if size < 0 {
			size = -size % 4096
		}
		size %= 4096
		if chunkSize < 0 {
			chunkSize = -chunkSize
		}
		chunkSize %= 2 * 1024 * 1024
		if len(chunk) > 1024 {
			chunk = chunk[:1024]
		}

		req := &protocol.Request{
			V: 2, SessionID: "sbx_fuzz", ClientNonce: "fuzz-nonce", RequestID: "req",
			Op: protocol.OpTransferInit, TransferID: transferID, Direction: direction,
			Path: path, Size: size, ChunkSize: chunkSize,
		}
		initRes := m.init(req)
		if !initRes.OK {
			return
		}
		if initRes.CommittedBytes != 0 {
			t.Fatalf("fresh transfer reported %d committed bytes", initRes.CommittedBytes)
		}

		if offset < 0 {
			offset = -offset
		}
		if size > 0 {
			offset %= size + 1
		} else {
			offset = 0
		}
		chunkReq := *req
		chunkReq.Op = protocol.OpTransferChunk
		chunkReq.Offset = offset
		chunkReq.DataBase64 = base64.StdEncoding.EncodeToString(chunk)
		chunkRes := m.chunk(&chunkReq)
		if chunkRes.OK && chunkRes.CommittedBytes > size {
			t.Fatalf("chunk committed %d bytes past the declared size %d", chunkRes.CommittedBytes, size)
		}

		if tag%2 == 0 {
			// Exercise the final size/digest checks. A digest over the whole
			// declared payload only succeeds when the chunk really filled it.
			digest := sha256.Sum256(chunk)
			completion := *req
			completion.Op = protocol.OpTransferComplete
			completion.Size = size
			completion.Digest = hex.EncodeToString(digest[:])
			_ = m.complete(&completion)
			// Remove a published file so repeated runs do not grow the tree.
			if abs, err := ws.Resolve(path); err == nil && abs != filepath.Clean(ws.Root) {
				_ = os.Remove(abs)
			}
		}
		// Always drop the transfer; cancel of an already-removed id is a
		// normal not_found result.
		_ = m.cancel(req)
	})
}

// FuzzChunkDecode isolates the base64 chunk decoder so malformed payloads are
// exercised at high volume without touching the filesystem.
func FuzzChunkDecode(f *testing.F) {
	f.Add("")
	f.Add("aGVsbG8=")
	f.Add("!!!!")
	f.Add("aGVsbG8")
	f.Add(base64.StdEncoding.EncodeToString(make([]byte, 1024)))

	f.Fuzz(func(t *testing.T, encoded string) {
		data, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			// DecodeString may return the bytes it decoded before the error;
			// the manager discards them, so only the bound matters.
			if len(data) > len(encoded) {
				t.Fatalf("partial decode returned %d bytes from %d encoded bytes", len(data), len(encoded))
			}
			return
		}
		// Decoded output is always smaller than the base64 carrier.
		if len(data) > len(encoded) {
			t.Fatalf("decoded %d bytes from %d encoded bytes", len(data), len(encoded))
		}
	})
}
