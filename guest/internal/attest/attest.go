package attest

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/x402s/sandbox/guest/internal/canonical"
)

// Config is everything the guest needs to produce evidence bound to this
// session and this customer's nonce.
type Config struct {
	SessionID       string
	ClientPublicKey string
	ClientNonce     string
	GuestPublicKey  string
	ExecutionMode   string // dev | kata | confidential
	RuntimeClass    string
	ImageDigest     string
	DevKeyID        string
	DevKeySeedB64   string
	Tools           []string
	// LeaseSeconds extends the evidence validity to cover the purchased lease.
	LeaseSeconds int64
}

// GuestMeasurement hashes the running executable. In a real confidential
// deployment this is replaced by the launch measurement reported by the TEE.
func GuestMeasurement() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(exe)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

func KernelRelease() string {
	data, err := os.ReadFile("/proc/sys/kernel/osrelease")
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(data))
}

// BuildEvidence creates a signed attestation envelope.
//
// SECURITY: only simulated modes are implemented here. The signing key is
// published in the repository, and every envelope is marked insecureDevOnly so
// a verifier can never confuse it with hardware evidence.
func BuildEvidence(cfg Config) (map[string]any, error) {
	if cfg.ExecutionMode == "confidential" {
		return nil, errors.New("confidential evidence requires a real SEV-SNP/TDX guest agent; refusing to fabricate it")
	}

	measurement, err := GuestMeasurement()
	if err != nil {
		return nil, fmt.Errorf("measure guest: %w", err)
	}
	bootNonce, err := randomB64(32)
	if err != nil {
		return nil, err
	}

	evidenceType := "dev-simulated"
	if cfg.ExecutionMode == "kata" {
		evidenceType = "kata-dev-no-hw-attestation"
	}

	now := time.Now()
	env := map[string]any{
		"v":               1,
		"evidenceType":    evidenceType,
		"insecureDevOnly": true,
		"hardwareBacked":  false,
		"sessionId":       cfg.SessionID,
		"guestPublicKey":  cfg.GuestPublicKey,
		"clientPublicKey": cfg.ClientPublicKey,
		"clientNonce":     cfg.ClientNonce,
		"bootNonce":       bootNonce,
		"issuedAt":        now.UnixMilli(),
		"expiresAt":       now.Add(time.Duration(cfg.LeaseSeconds)*time.Second + 300*time.Second).UnixMilli(),
		"report":          "",
		"claims": map[string]any{
			"guestMeasurement":    measurement,
			"imageDigest":         cfg.ImageDigest,
			"runtimeClass":        cfg.RuntimeClass,
			"kernelRelease":       KernelRelease(),
			"hardwareBacked":      false,
			"guestPolicyEnforced": false,
			"tools":               cfg.Tools,
		},
	}

	priv, keyID, err := devKey(cfg)
	if err != nil {
		return nil, err
	}
	canonicalBytes, err := canonical.Marshal(env)
	if err != nil {
		return nil, err
	}
	sig := ed25519.Sign(priv, canonicalBytes)
	env["signature"] = map[string]any{
		"alg":   "ed25519",
		"keyId": keyID,
		"value": base64.StdEncoding.EncodeToString(sig),
	}
	return env, nil
}

// devKey loads the Ed25519 seed from the environment. The seed is injected by
// the controller from a Kubernetes Secret that exists only in dev deploys.
func devKey(cfg Config) (ed25519.PrivateKey, string, error) {
	seed, err := base64.StdEncoding.DecodeString(cfg.DevKeySeedB64)
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, "", errors.New("missing or malformed dev attestation key (expected 32-byte base64 seed)")
	}
	keyID := cfg.DevKeyID
	if keyID == "" {
		keyID = "x402-dev-attestation-key-INSECURE-DEV-ONLY"
	}
	return ed25519.NewKeyFromSeed(seed), keyID, nil
}

func randomB64(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(buf), nil
}
