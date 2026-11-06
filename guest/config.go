package main

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type sessionConfig struct {
	SessionID         string
	RelayURL          string
	GuestToken        string
	ClientPublicKey   string
	ClientNonce       string
	LeaseSeconds      int64
	ExecutionMode     string
	RuntimeClass      string
	ImageDigest       string
	DevKey            string
	DevKeyID          string
	ProxyURL          string
	ProxyToken        string
	MaxOutput         int
	MaxFileBytes      int64
	MaxTransferBytes  int64
	MaxDiskMiB        int64
	MaxCommandSeconds int
	MaxProcesses      int
	WorkspaceDir      string
	Tools             string
}

func configFromEnv() sessionConfig {
	sessionID := requireEnv("SESSION_ID")
	relayURL := requireEnv("RELAY_URL")
	token, devKey, devKeyID, bootProxyToken := loadBootstrap()
	proxyToken := os.Getenv("PROXY_TOKEN")
	if bootProxyToken != "" {
		proxyToken = bootProxyToken
	}
	return sessionConfig{
		SessionID:         sessionID,
		RelayURL:          withToken(relayURL, token),
		GuestToken:        token,
		ClientPublicKey:   requireEnv("CLIENT_PUBLIC_KEY"),
		ClientNonce:       requireEnv("CLIENT_NONCE"),
		LeaseSeconds:      int64(parseIntEnv("LEASE_SECONDS", 300)),
		ExecutionMode:     getEnv("EXECUTION_MODE", "dev"),
		RuntimeClass:      os.Getenv("RUNTIME_CLASS"),
		ImageDigest:       os.Getenv("GUEST_IMAGE_DIGEST"),
		DevKey:            devKey,
		DevKeyID:          devKeyID,
		ProxyURL:          os.Getenv("EGRESS_PROXY_URL"),
		ProxyToken:        proxyToken,
		MaxOutput:         parseIntEnv("MAX_OUTPUT_BYTES", 262144),
		MaxFileBytes:      int64(parseIntEnv("MAX_FILE_BYTES", 8*1024*1024)),
		MaxTransferBytes:  int64(parseIntEnv("MAX_TRANSFER_BYTES", 256*1024*1024)),
		MaxDiskMiB:        int64(parseIntEnv("MAX_DISK_MIB", 256)),
		MaxCommandSeconds: parseIntEnv("MAX_COMMAND_SECONDS", 300),
		MaxProcesses:      parseIntEnv("MAX_PROCESSES", 256),
		WorkspaceDir:      getEnv("WORKSPACE_DIR", defaultWorkspace),
		Tools:             getEnv("GUEST_TOOLS", "python3,node,bash,tar,curl,git"),
	}
}

func withToken(relayURL, token string) string {
	if token == "" {
		return relayURL
	}
	separator := "?"
	if strings.Contains(relayURL, "?") {
		separator = "&"
	}
	return relayURL + separator + "token=" + url.QueryEscape(token)
}

func bootstrap() error {
	dir := sandboxDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	payload := map[string]string{
		"guestToken":          os.Getenv("GUEST_TOKEN"),
		"devAttestationKey":   os.Getenv("DEV_ATTESTATION_KEY"),
		"devAttestationKeyId": os.Getenv("DEV_ATTESTATION_KEY_ID"),
		"proxyToken":          os.Getenv("PROXY_TOKEN"),
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "bootstrap.json"), data, 0o400)
}

func loadBootstrap() (token, devKey, devKeyID, proxyToken string) {
	path := filepath.Join(sandboxDir(), "bootstrap.json")
	data, err := os.ReadFile(path)
	if err == nil {
		var payload struct {
			GuestToken          string `json:"guestToken"`
			DevAttestationKey   string `json:"devAttestationKey"`
			DevAttestationKeyId string `json:"devAttestationKeyId"`
			ProxyToken          string `json:"proxyToken"`
		}
		if json.Unmarshal(data, &payload) == nil {
			_ = os.Remove(path)
			return payload.GuestToken, payload.DevAttestationKey, payload.DevAttestationKeyId, payload.ProxyToken
		}
	}
	return os.Getenv("GUEST_TOKEN"), os.Getenv("DEV_ATTESTATION_KEY"), os.Getenv("DEV_ATTESTATION_KEY_ID"), os.Getenv("PROXY_TOKEN")
}

func requireEnv(name string) string {
	v := os.Getenv(name)
	if v == "" {
		logEvent("config_error", map[string]any{"missing": name})
		os.Exit(1)
	}
	return v
}

func getEnv(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func sandboxDir() string {
	if v := os.Getenv("X402_SANDBOX_DIR"); v != "" {
		return v
	}
	return "/run/x402"
}

func parseIntEnv(name string, def int) int {
	v := os.Getenv(name)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return def
	}
	return n
}
