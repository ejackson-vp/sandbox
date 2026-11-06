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

func testManager(t *testing.T) (*transferManager, *files.Workspace) {
	t.Helper()
	root := t.TempDir()
	ws, err := files.New(root, 8*1024*1024, 64*1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	return newTransferManager(ws, 32*1024*1024), ws
}

func req(id, direction, path string, size int64) *protocol.Request {
	return &protocol.Request{V: 2, SessionID: "sbx_test", ClientNonce: "nonce", RequestID: "req", Op: protocol.OpTransferInit, TransferID: id, Direction: direction, Path: path, Size: size, ChunkSize: 64 * 1024}
}

func TestUploadPublishesOnlyAfterDigest(t *testing.T) {
	m, ws := testManager(t)
	data := []byte("hello transfer")
	sum := sha256.Sum256(data)
	r := req("transfer-1", "upload", "result.txt", int64(len(data)))
	if got := m.init(r); !got.OK {
		t.Fatalf("init: %+v", got.Error)
	}
	chunkReq := *r
	chunkReq.Op = protocol.OpTransferChunk
	chunkReq.Offset = 0
	chunkReq.DataBase64 = base64.StdEncoding.EncodeToString(data)
	if got := m.chunk(&chunkReq); !got.OK {
		t.Fatalf("chunk: %+v", got.Error)
	}
	if _, err := os.Stat(filepath.Join(ws.Root, "result.txt")); !os.IsNotExist(err) {
		t.Fatal("destination became visible before completion")
	}
	complete := *r
	complete.Op = protocol.OpTransferComplete
	complete.Digest = hex.EncodeToString(sum[:])
	if got := m.complete(&complete); !got.OK {
		t.Fatalf("complete: %+v", got.Error)
	}
	got, err := os.ReadFile(filepath.Join(ws.Root, "result.txt"))
	if err != nil || string(got) != string(data) {
		t.Fatalf("published content = %q, %v", got, err)
	}
}

func TestChunkOrderAndDuplicate(t *testing.T) {
	m, _ := testManager(t)
	r := req("transfer-2", "upload", "x.bin", 6)
	if got := m.init(r); !got.OK {
		t.Fatal(got.Error)
	}
	chunk := *r
	chunk.Op = protocol.OpTransferChunk
	chunk.Offset = 3
	chunk.DataBase64 = base64.StdEncoding.EncodeToString([]byte("def"))
	if got := m.chunk(&chunk); got.OK || got.Error.Code != "out_of_order" {
		t.Fatalf("expected out_of_order: %+v", got)
	}
	chunk.Offset = 0
	chunk.DataBase64 = base64.StdEncoding.EncodeToString([]byte("abc"))
	if got := m.chunk(&chunk); !got.OK {
		t.Fatal(got.Error)
	}
	if got := m.chunk(&chunk); !got.OK {
		t.Fatalf("duplicate must be acknowledged: %+v", got.Error)
	}
}

func TestUploadRejectsTraversalAndConcurrentPath(t *testing.T) {
	m, _ := testManager(t)
	if got := m.init(req("transfer-3", "upload", "../escape", 1)); got.OK || got.Error.Code != "invalid_path" {
		t.Fatalf("expected invalid_path: %+v", got)
	}
	if got := m.init(req("transfer-4", "upload", "same.bin", 10)); !got.OK {
		t.Fatal(got.Error)
	}
	if got := m.init(req("transfer-5", "upload", "same.bin", 10)); got.OK || got.Error.Code != "path_busy" {
		t.Fatalf("expected path_busy: %+v", got)
	}
}
