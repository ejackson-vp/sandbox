package envelope

import (
	"encoding/base64"
	"testing"
)

// FuzzOpen drives the sealed-box decoder with arbitrary base64 strings. The
// decoder is the guest's first parser: everything the customer sends arrives
// as one base64 envelope inside a relay frame, so it must fail closed (nil
// output, bounded error) and never panic on truncated, oversized, or
// non-canonical input.
//
// Seeds come from the shapes the guest already accepts and rejects in
// production: a valid sealed operation, empty input, invalid base64, a
// too-short box, and random bytes with the right length.
func FuzzOpen(f *testing.F) {
	keys, err := GenerateKeyPair()
	if err != nil {
		f.Fatalf("generate key pair: %v", err)
	}
	valid, err := Seal(keys.Public, []byte(`{"v":2,"sessionId":"sbx_fuzz","op":"exec","command":["true"]}`))
	if err != nil {
		f.Fatalf("seal seed: %v", err)
	}
	f.Add(valid)
	f.Add("")
	f.Add("not base64!")
	f.Add(base64.StdEncoding.EncodeToString([]byte("short")))
	f.Add(base64.StdEncoding.EncodeToString(make([]byte, 4096)))
	f.Add(base64.RawStdEncoding.EncodeToString(make([]byte, 64)))

	f.Fuzz(func(t *testing.T, encoded string) {
		out, err := keys.Open(encoded)
		if err != nil {
			if out != nil {
				t.Fatalf("Open returned plaintext with an error: %d bytes", len(out))
			}
			return
		}
		// A successful open can only produce plaintext shorter than its
		// base64 carrier (3 bytes decoded per 4 encoded).
		if len(out) > len(encoded) {
			t.Fatalf("plaintext %d bytes exceeds carrier %d bytes", len(out), len(encoded))
		}
		if len(out) > MaxEnvelopeBytes {
			t.Fatalf("plaintext %d bytes exceeds MaxEnvelopeBytes %d", len(out), MaxEnvelopeBytes)
		}
	})
}

// TestOpenRejectsOversizedEnvelope covers the explicit cap without relying on
// the fuzzer to grow an 18 MiB input. The relay caps frames at 24 MiB, so a
// decoded envelope just over the limit must be rejected before any crypto.
func TestOpenRejectsOversizedEnvelope(t *testing.T) {
	keys, err := GenerateKeyPair()
	if err != nil {
		t.Fatalf("generate key pair: %v", err)
	}
	encoded := base64.StdEncoding.EncodeToString(make([]byte, MaxEnvelopeBytes+1))
	if _, err := keys.Open(encoded); err == nil {
		t.Fatal("Open accepted an envelope above MaxEnvelopeBytes")
	}
}
