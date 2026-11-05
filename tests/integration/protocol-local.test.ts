/**
 * Local protocol test: real relay + real Go guest + Node client.
 *
 * This exercises the exact confidentiality protocol used in Kubernetes without
 * needing a cluster: guest-initiated relay channel, Ed25519-signed dev
 * attestation, libsodium sealed-box interop between Node and Go, and the
 * single-execution relay semantics.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelay, type RelayServer } from "../../controller/src/relay.js";
import { RelayClient } from "../../controller/src/relay-client.js";
import {
  DEV_ATTESTATION_PUBLIC_KEY,
  fromBase64,
  generateBoxKeyPair,
  generateNonce,
  openSealedJson,
  sealJsonTo,
  toBase64,
  verifyAttestation,
  type AttestationEnvelope,
  type ExecutePlaintext,
  type ResultPlaintext,
} from "../../shared/src/index.js";

const RELAY_PORT = 18443;
const ADMIN = "test-admin-token-0123456789";
const DEV_SEED = "qSgP+dPwGhb/58O0ZD/dSqCMovhhWNIQbT3MeTD35WY=";
const sessionId = "sbx_0123456789abcdef01234567";

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 20_000, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("timeout waiting for condition");
}

describe("guest protocol (local processes)", () => {
  let relay: RelayServer;
  let relayClient: RelayClient;
  let guest: ChildProcess | undefined;
  let workspace: string;
  const guestToken = "guest-token-for-test-0123456789";

  beforeAll(async () => {
    relay = createRelay({ adminToken: ADMIN, resultTtlMs: 60_000 });
    await new Promise<void>((resolve) => relay.server.listen(RELAY_PORT, "127.0.0.1", () => resolve()));
    relayClient = new RelayClient({ baseUrl: `http://127.0.0.1:${RELAY_PORT}`, adminToken: ADMIN });
    workspace = await mkdtemp(join(tmpdir(), "x402-guest-test-"));
  });

  afterAll(async () => {
    if (guest && !guest.killed) guest.kill("SIGKILL");
    await relay.close();
    await rm(workspace, { recursive: true, force: true });
  });

  it("runs the full attested encrypted round trip", async () => {
    const binary = process.env.GUEST_BINARY ?? join(process.cwd(), "guest/bin/x402-guest");
    if (!existsSync(binary)) {
      throw new Error(`guest binary not found at ${binary}; run 'make guest' first`);
    }

    const clientKeys = await generateBoxKeyPair();
    const clientNonce = toBase64(await generateNonce());

    await relayClient.register(sessionId, sha256Hex(guestToken), 120_000);

    guest = spawn(binary, ["run"], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        SESSION_ID: sessionId,
        RELAY_URL: `ws://127.0.0.1:${RELAY_PORT}/guest?session=${sessionId}&token=${guestToken}`,
        CLIENT_PUBLIC_KEY: toBase64(clientKeys.publicKey),
        CLIENT_NONCE: clientNonce,
        EXEC_DURATION_SECONDS: "30",
        EXECUTION_MODE: "dev",
        RUNTIME_CLASS: "x402-sandbox",
        GUEST_IMAGE_DIGEST: "sha256:test",
        MAX_OUTPUT_BYTES: "65536",
        DEV_ATTESTATION_KEY: DEV_SEED,
        DEV_ATTESTATION_KEY_ID: "x402-dev-attestation-key-INSECURE-DEV-ONLY",
        EGRESS_PROXY_URL: "",
        PROXY_TOKEN: "",
        X402_SANDBOX_DIR: join(workspace, "run"),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });

    const state = await waitFor(async () => {
      const s = await relayClient.state(sessionId);
      return s.connected && s.attestation ? s : null;
    });

    const evidence = state.attestation as AttestationEnvelope;
    expect(evidence.evidenceType).toBe("dev-simulated");
    expect(evidence.insecureDevOnly).toBe(true);

    // Independent verification, exactly as the CLI does it.
    const verdict = verifyAttestation(evidence, {
      mode: "dev",
      allowInsecureDev: true,
      expectedSessionId: sessionId,
      expectedClientNonce: clientNonce,
      expectedClientPublicKey: toBase64(clientKeys.publicKey),
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.guestMeasurement).toMatch(/^[0-9a-f]{64}$/);

    // A tampered binding must fail closed.
    const tampered = { ...evidence, clientNonce: toBase64(new Uint8Array(32)) };
    expect(verifyAttestation(tampered, {
      mode: "dev",
      allowInsecureDev: true,
      expectedSessionId: sessionId,
      expectedClientNonce: clientNonce,
      expectedClientPublicKey: toBase64(clientKeys.publicKey),
    }).ok).toBe(false);

    // The dev key is pinned; a different pinned key would reject it.
    expect(DEV_ATTESTATION_PUBLIC_KEY).toHaveLength(44);

    const guestKey = fromBase64(evidence.guestPublicKey);
    const payload: ExecutePlaintext = {
      v: 1,
      sessionId,
      clientNonce,
      language: "python3",
      code: "import sys\nprint('hello from the guest')\nprint('warn', file=sys.stderr)\nsys.exit(3)\n",
    };
    const envelope = await sealJsonTo(guestKey, payload);
    await relayClient.deliver(sessionId, envelope, Date.now() + 30_000);

    const resultEnvelope = await waitFor(async () => {
      const out = await relayClient.result(sessionId, 2000);
      return out.envelope ?? null;
    }, 30_000);

    const result = await openSealedJson<ResultPlaintext>(resultEnvelope, clientKeys.publicKey, clientKeys.privateKey);
    expect(result.v).toBe(1);
    expect(result.sessionId).toBe(sessionId);
    expect(result.clientNonce).toBe(clientNonce);
    expect(result.stdout).toContain("hello from the guest");
    expect(result.stderr).toContain("warn");
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);

    // A different client key cannot decrypt the result.
    const wrong = await generateBoxKeyPair();
    await expect(
      openSealedJson<ResultPlaintext>(resultEnvelope, wrong.publicKey, wrong.privateKey),
    ).rejects.toThrow(/decryption failed/);

    // A second delivery must be refused by the relay.
    await expect(relayClient.deliver(sessionId, envelope, Date.now() + 30_000)).rejects.toMatchObject({
      status: 409,
    });
  }, 60_000);

  it("enforces the guest watchdog and returns an encrypted timeout result", async () => {
    const id = "sbx_89abcdef0123456789abcdef";
    const token = "guest-token-timeout-0123456789";
    const clientKeys = await generateBoxKeyPair();
    const clientNonce = toBase64(await generateNonce());
    await relayClient.register(id, sha256Hex(token), 120_000);

    const proc = spawn(process.env.GUEST_BINARY ?? join(process.cwd(), "guest/bin/x402-guest"), ["run"], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        SESSION_ID: id,
        RELAY_URL: `ws://127.0.0.1:${RELAY_PORT}/guest?session=${id}&token=${token}`,
        CLIENT_PUBLIC_KEY: toBase64(clientKeys.publicKey),
        CLIENT_NONCE: clientNonce,
        EXEC_DURATION_SECONDS: "2",
        EXECUTION_MODE: "dev",
        RUNTIME_CLASS: "x402-sandbox",
        GUEST_IMAGE_DIGEST: "sha256:test",
        MAX_OUTPUT_BYTES: "65536",
        DEV_ATTESTATION_KEY: DEV_SEED,
        PROXY_TOKEN: "",
        EGRESS_PROXY_URL: "",
        X402_SANDBOX_DIR: join(workspace, "run2"),
      },
      stdio: ["ignore", "ignore", "ignore"],
    });

    try {
      const state = await waitFor(async () => {
        const s = await relayClient.state(id);
        return s.connected && s.attestation ? s : null;
      });
      const guestKey = fromBase64((state.attestation as AttestationEnvelope).guestPublicKey);
      const envelope = await sealJsonTo(guestKey, {
        v: 1,
        sessionId: id,
        clientNonce,
        language: "python3",
        code: "while True:\n    pass\n",
      } satisfies ExecutePlaintext);
      await relayClient.deliver(id, envelope, Date.now() + 60_000);

      const resultEnvelope = await waitFor(async () => {
        const out = await relayClient.result(id, 2000);
        return out.envelope ?? null;
      }, 30_000);

      const result = await openSealedJson<ResultPlaintext>(resultEnvelope, clientKeys.publicKey, clientKeys.privateKey);
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(-1);
      expect(result.durationMs).toBeGreaterThanOrEqual(1900);
      expect(result.durationMs).toBeLessThan(8000);
    } finally {
      proc.kill("SIGKILL");
      await relayClient.purge(id).catch(() => undefined);
    }
  }, 45_000);
});
