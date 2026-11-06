// Package envelope implements the libsodium sealed-box envelope used between
// the CLI and the guest. golang.org/x/crypto/nacl/box SealAnonymous is the same
// construction as libsodium crypto_box_seal (X25519 + XSalsa20-Poly1305 with a
// BLAKE2b nonce derived from the ephemeral public key).
package envelope

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"

	"golang.org/x/crypto/nacl/box"
)

// Must stay below the relay frame cap (24 MiB) after base64 expansion.
const MaxEnvelopeBytes = 18 * 1024 * 1024

// KeyPair is an ephemeral X25519 key pair.
type KeyPair struct {
	Public  *[32]byte
	Private *[32]byte
}

func GenerateKeyPair() (*KeyPair, error) {
	pub, priv, err := box.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	return &KeyPair{Public: pub, Private: priv}, nil
}

func PublicKeyFromBase64(s string) (*[32]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(raw) != 32 {
		return nil, errors.New("invalid public key")
	}
	var k [32]byte
	copy(k[:], raw)
	return &k, nil
}

func (k *KeyPair) PublicBase64() string {
	return base64.StdEncoding.EncodeToString(k.Public[:])
}

// Open decrypts a base64 sealed box addressed to this key pair.
func (k *KeyPair) Open(b64 string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, errors.New("invalid base64 envelope")
	}
	if len(raw) > MaxEnvelopeBytes {
		return nil, errors.New("envelope too large")
	}
	out, ok := box.OpenAnonymous(nil, raw, k.Public, k.Private)
	if !ok {
		return nil, errors.New("decryption failed")
	}
	return out, nil
}

// Seal encrypts plaintext to the recipient public key and returns base64.
func Seal(recipient *[32]byte, plaintext []byte) (string, error) {
	out, err := box.SealAnonymous(nil, plaintext, recipient, rand.Reader)
	if err != nil {
		return "", fmt.Errorf("seal: %w", err)
	}
	return base64.StdEncoding.EncodeToString(out), nil
}

func RandomBase64(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, buf); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(buf), nil
}
