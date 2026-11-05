// Command x402-guest is the trusted guest runtime. It runs inside the sandbox
// pod (a plain pod in dev mode, a Kata VM in kata mode, a CoCo TEE in
// confidential mode), generates an ephemeral key pair, attests to it, decrypts
// the customer payload only inside the guest, executes it, and returns an
// encrypted result.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"net/url"
	"path/filepath"

	"github.com/x402s/sandbox/guest/internal/attest"
	"github.com/x402s/sandbox/guest/internal/envelope"
	"github.com/x402s/sandbox/guest/internal/relay"
	"github.com/x402s/sandbox/guest/internal/runner"
)

func main() {
	cmd := "run"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	switch cmd {
	case "run":
		if err := run(); err != nil {
			logEvent("guest_failed", map[string]any{"error": err.Error()})
			os.Exit(1)
		}
	case "bootstrap":
		// Init-container mode: move short-lived credentials out of the process
		// environment before the guest (and therefore the customer payload)
		// starts, so /proc/1/environ never contains them.
		if err := bootstrap(); err != nil {
			logEvent("bootstrap_failed", map[string]any{"error": err.Error()})
			os.Exit(1)
		}
	case "version":
		fmt.Println("x402-guest 0.1.0")
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", cmd)
		os.Exit(2)
	}
}

type executePlaintext struct {
	V           int    `json:"v"`
	SessionID   string `json:"sessionId"`
	ClientNonce string `json:"clientNonce"`
	Language    string `json:"language"`
	Code        string `json:"code"`
	Stdin       string `json:"stdin"`
}

func run() error {
	sessionID := requireEnv("SESSION_ID")
	relayURL := requireEnv("RELAY_URL")
	token, devKey, devKeyID, bootProxyToken := loadBootstrap()
	if token != "" {
		separator := "?"
		if strings.Contains(relayURL, "?") {
			separator = "&"
		}
		relayURL = relayURL + separator + "token=" + url.QueryEscape(token)
	}
	clientPublicKeyB64 := requireEnv("CLIENT_PUBLIC_KEY")
	clientNonce := requireEnv("CLIENT_NONCE")
	execSeconds := parseIntEnv("EXEC_DURATION_SECONDS", 60)
	executionMode := getEnv("EXECUTION_MODE", "dev")
	outputLimit := parseIntEnv("MAX_OUTPUT_BYTES", 65536)
	proxyURL := os.Getenv("EGRESS_PROXY_URL")
	proxyToken := os.Getenv("PROXY_TOKEN")
	if bootProxyToken != "" {
		proxyToken = bootProxyToken
	}

	clientKey, err := envelope.PublicKeyFromBase64(clientPublicKeyB64)
	if err != nil {
		return fmt.Errorf("client public key: %w", err)
	}

	keyPair, err := envelope.GenerateKeyPair()
	if err != nil {
		return fmt.Errorf("ephemeral key: %w", err)
	}

	evidence, err := attest.BuildEvidence(attest.Config{
		SessionID:       sessionID,
		ClientPublicKey: clientPublicKeyB64,
		ClientNonce:     clientNonce,
		GuestPublicKey:  keyPair.PublicBase64(),
		ExecutionMode:   executionMode,
		RuntimeClass:    os.Getenv("RUNTIME_CLASS"),
		ImageDigest:     os.Getenv("GUEST_IMAGE_DIGEST"),
		DevKeyID:        devKeyID,
		DevKeySeedB64:   devKey,
	})
	if err != nil {
		return fmt.Errorf("attestation: %w", err)
	}

	logEvent("guest_started", map[string]any{
		"sessionId":     sessionID,
		"executionMode": executionMode,
		"kernelRelease": attest.KernelRelease(),
	})

	ctx := context.Background()
	client, err := relay.Dial(ctx, relayURL, 45*time.Second)
	if err != nil {
		return err
	}
	defer client.Close()

	if err := client.SendHello(ctx, evidence); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}
	logEvent("guest_hello_sent", map[string]any{"sessionId": sessionID})

	waitCtx, cancelWait := context.WithTimeout(ctx, time.Duration(execSeconds+120)*time.Second)
	defer cancelWait()
	msg, err := client.AwaitExecute(waitCtx)
	if err != nil {
		return fmt.Errorf("await execute: %w", err)
	}

	budget := time.Duration(execSeconds) * time.Second
	if msg.DeadlineMs > 0 {
		remaining := time.Until(time.UnixMilli(msg.DeadlineMs))
		if remaining <= 0 {
			_ = client.SendError(ctx, "deadline_passed", "execution window elapsed")
			return errors.New("execution window elapsed before payload arrival")
		}
		if remaining < budget {
			budget = remaining
		}
	}

	plaintext, err := keyPair.Open(msg.Envelope)
	if err != nil {
		// Never echo ciphertext or key material.
		_ = client.SendError(ctx, "decrypt_failed", "payload could not be decrypted")
		return errors.New("payload decryption failed")
	}
	var payload executePlaintext
	if err := json.Unmarshal(plaintext, &payload); err != nil {
		_ = client.SendError(ctx, "malformed_payload", "payload is not a valid execution request")
		return errors.New("malformed execute payload")
	}
	// Bind the payload to this exact session and nonce.
	if payload.V != 1 || payload.SessionID != sessionID || payload.ClientNonce != clientNonce {
		_ = client.SendError(ctx, "binding_mismatch", "payload is bound to a different session")
		return errors.New("execute payload binding mismatch")
	}
	if payload.Language != "python3" {
		_ = client.SendError(ctx, "unsupported_language", "only python3 is supported")
		return errors.New("unsupported language")
	}
	// Plaintext exists only inside the guest from here on.
	plaintext = nil

	execCtx, cancelExec := context.WithCancel(ctx)
	defer cancelExec()
	result, err := runner.Execute(execCtx, sessionID, clientNonce, payload.Code, payload.Stdin, budget, outputLimit, proxyURL, proxyToken)
	if err != nil {
		_ = client.SendError(ctx, "execution_failed", "sandbox execution failed")
		return err
	}
	payload.Code = ""
	payload.Stdin = ""

	resultJSON, err := json.Marshal(result)
	if err != nil {
		_ = client.SendError(ctx, "result_encoding_failed", "could not encode result")
		return err
	}
	sealed, err := envelope.Seal(clientKey, resultJSON)
	if err != nil {
		_ = client.SendError(ctx, "result_encryption_failed", "could not encrypt result")
		return err
	}
	if err := client.SendResult(ctx, sealed); err != nil {
		return fmt.Errorf("send result: %w", err)
	}

	// Zero out local copies of plaintext before exiting.
	for i := range resultJSON {
		resultJSON[i] = 0
	}
	logEvent("guest_finished", map[string]any{
		"sessionId":  sessionID,
		"exitCode":   result.ExitCode,
		"timedOut":   result.TimedOut,
		"durationMs": result.DurationMs,
		"stdoutLen":  len(result.Stdout),
		"stderrLen":  len(result.Stderr),
	})
	return nil
}

// bootstrap writes credentials to a mode-0400 file for the main container.
func bootstrap() error {
	dir := sandboxDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	payload := map[string]string{
		"guestToken":          os.Getenv("GUEST_TOKEN"),
		"devAttestationKey":   os.Getenv("DEV_ATTESTATION_KEY"),
		"devAttestationKeyId": os.Getenv("DEV_ATTESTATION_KEY_ID"),
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	path := filepath.Join(dir, "bootstrap.json")
	if err := os.WriteFile(path, data, 0o400); err != nil {
		return err
	}
	return nil
}

// loadBootstrap reads and immediately removes the bootstrap file, falling back
// to environment variables for local (non-Kubernetes) runs.
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
	return runner.DefaultSandboxDir
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

// logEvent writes structured diagnostics to the pod log. It is used only for
// non-sensitive metadata: never code, output, tokens or keys.
func logEvent(event string, fields map[string]any) {
	line := map[string]any{
		"ts":      time.Now().UTC().Format(time.RFC3339Nano),
		"level":   "info",
		"service": "guest",
		"event":   event,
	}
	for k, v := range fields {
		line[k] = v
	}
	data, err := json.Marshal(line)
	if err != nil {
		return
	}
	fmt.Fprintln(os.Stderr, string(data))
}
