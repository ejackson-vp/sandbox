/**
 * Client runtime behaviour that a refactor could quietly invert.
 *
 * The transport itself is stubbed at `fetch`, so what is under test is the
 * policy on top of it: what the client accepts as a READY session, what it does
 * with a result that was sealed for another session or another request, and
 * which HTTP answers are retried versus surfaced.
 *
 * The attestation fixtures are real: the same dev key and canonical bytes the
 * guest signs with, because the point is that a session bound to someone else's
 * key, nonce or id is refused by the client and not only by the verifier.
 */
import { createPrivateKey, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalEvidenceBytes,
  DEV_ATTESTATION_KEY_ID,
  generateBoxKeyPair,
  sealJsonTo,
  toBase64,
} from "../../shared/src/entries/crypto.js";
import type { AttestationEnvelope } from "../../shared/src/entries/protocol.js";
import { SandboxClient } from "../../sdk/src/client.js";
import { SandboxError, SessionExpiredError, type SessionHandle } from "../../sdk/src/types.js";
import type { FileSessionStore } from "../../sdk/src/session-store.js";

const SESSION_ID = "sbx_0123456789abcdef01234567";
const REQUEST_ID = "req-runtime-0001";
const NONCE = "AAAA".repeat(10) + "AAA=";
const DEV_SEED_B64 = "qSgP+dPwGhb/58O0ZD/dSqCMovhhWNIQbT3MeTD35WY=";
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): SandboxClient {
  return new SandboxClient({ apiUrl: "http://api.test", paymentMode: "mock", allowInsecureDev: true });
}

interface Keys {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

async function keys(): Promise<Keys> {
  const pair = await generateBoxKeyPair();
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

function handleFor(clientKeys: Keys, overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    sessionId: SESSION_ID,
    capability: "c".repeat(24),
    clientPublicKey: clientKeys.publicKey,
    clientPrivateKey: clientKeys.privateKey,
    clientNonce: NONCE,
    createdAt: 0,
    ...overrides,
  };
}

function signEvidence(evidence: AttestationEnvelope): AttestationEnvelope {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(DEV_SEED_B64, "base64")]),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(null, canonicalEvidenceBytes(evidence), key);
  return { ...evidence, signature: { alg: "ed25519", keyId: DEV_ATTESTATION_KEY_ID, value: signature.toString("base64") } };
}

interface StatusOverrides {
  state?: string;
  clientPublicKey?: string;
  clientNonce?: string;
  sessionId?: string;
  guestPublicKey?: string;
  attestation?: AttestationEnvelope | undefined;
  failureCode?: string;
  executionMode?: string;
}

/** A READY status carrying evidence that is bound to this client unless told otherwise. */
function readyStatus(clientKeys: Keys, guestKeys: Keys, overrides: StatusOverrides = {}) {
  const now = Date.now();
  const guestPublicKey = overrides.guestPublicKey ?? toBase64(guestKeys.publicKey);
  const evidence = signEvidence({
    v: 1,
    evidenceType: "dev-simulated",
    insecureDevOnly: true,
    hardwareBacked: false,
    sessionId: overrides.sessionId ?? SESSION_ID,
    guestPublicKey,
    clientPublicKey: overrides.clientPublicKey ?? toBase64(clientKeys.publicKey),
    clientNonce: overrides.clientNonce ?? NONCE,
    bootNonce: "D".repeat(43) + "A=",
    issuedAt: now - 1_000,
    expiresAt: now + 60_000,
    claims: {
      guestMeasurement: "a".repeat(64),
      imageDigest: "sha256:test",
      runtimeClass: "x402-sandbox",
      hardwareBacked: false,
      guestPolicyEnforced: false,
    },
    report: "",
    signature: { alg: "ed25519", keyId: DEV_ATTESTATION_KEY_ID, value: "" },
  });
  return {
    sessionId: overrides.sessionId ?? SESSION_ID,
    state: overrides.state ?? "READY",
    tier: "short",
    durationSeconds: 60,
    limits: {},
    createdAt: now,
    remainingSeconds: 60,
    clientNonce: overrides.clientNonce ?? NONCE,
    busy: false,
    executionMode: overrides.executionMode ?? "dev",
    payment: {
      mode: "mock",
      network: "mock:local",
      scheme: "exact",
      asset: "mock:usdc",
      amount: "50000",
      priceUsd: "0.05",
      payTo: "0x0000000000000000000000000000000000000402",
    },
    ...(overrides.state === "FAILED" && overrides.failureCode
      ? { failure: { code: overrides.failureCode, message: "boom" } }
      : {}),
    guestPublicKey,
    ...(overrides.attestation === undefined ? { attestation: evidence } : { attestation: overrides.attestation }),
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Stub fetch with a queue of answers; the last one repeats. */
function stubFetch(answers: Array<() => Response | Promise<Response>>): () => number {
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    const answer = answers[Math.min(calls, answers.length - 1)]!;
    calls += 1;
    return answer();
  });
  return () => calls;
}

describe("waitForReady", () => {
  it("waits through PAID and PROVISIONING, then accepts the bound evidence", async () => {
    const clientKeys = await keys();
    const guestKeys = await keys();
    const handle = handleFor(clientKeys);
    const store = new Map<string, unknown>();
    const sdk = new SandboxClient({
      apiUrl: "http://api.test",
      paymentMode: "mock",
      allowInsecureDev: true,
      store: { save: (row: unknown) => store.set(SESSION_ID, row) } as unknown as FileSessionStore,
    });
    stubFetch([
      () => json(200, readyStatus(clientKeys, guestKeys, { state: "PAID" })),
      () => json(200, readyStatus(clientKeys, guestKeys, { state: "PROVISIONING" })),
      () => json(200, readyStatus(clientKeys, guestKeys)),
    ]);

    const status = await sdk.waitForReady(handle, 5_000);

    expect(status.state).toBe("READY");
    expect(handle.guestPublicKey).toEqual(guestKeys.publicKey);
    // The guest key is persisted with the handle, because the next process
    // needs it to seal an operation without a status round trip.
    expect(store.get(SESSION_ID)).toMatchObject({ sessionId: SESSION_ID, guestPublicKey: toBase64(guestKeys.publicKey) });
  });

  it("reports an expiring session as a lease that ended", async () => {
    const clientKeys = await keys();
    stubFetch([() => json(200, { sessionId: SESSION_ID, state: "EXPIRED", tier: "short", durationSeconds: 60 })]);
    const error = await client().waitForReady(handleFor(clientKeys), 2_000).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SessionExpiredError);
    expect(error).toMatchObject({ code: "lease_expired" });
  });

  it("reports a failed session with the guest's failure code", async () => {
    const clientKeys = await keys();
    stubFetch([() => json(200, { sessionId: SESSION_ID, state: "FAILED", failure: { code: "image_pull_failed", message: "x" } })]);
    await expect(client().waitForReady(handleFor(clientKeys), 2_000)).rejects.toMatchObject({
      code: "session_failed",
      message: expect.stringContaining("image_pull_failed"),
    });
  });

  it("refuses a READY session that offers no evidence", async () => {
    const clientKeys = await keys();
    const guestKeys = await keys();
    stubFetch([() => json(200, readyStatus(clientKeys, guestKeys, { attestation: null as never }))]);
    await expect(client().waitForReady(handleFor(clientKeys), 2_000)).rejects.toMatchObject({
      code: "missing_attestation",
    });
  });

  it("refuses evidence that is bound to another client key", async () => {
    const clientKeys = await keys();
    const otherKeys = await keys();
    const guestKeys = await keys();
    stubFetch([
      () => json(200, readyStatus(clientKeys, guestKeys, { clientPublicKey: toBase64(otherKeys.publicKey) })),
    ]);
    const error = await client().waitForReady(handleFor(clientKeys), 2_000).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SandboxError);
    expect(error).toMatchObject({ code: "attestation_rejected" });
  });

  it("refuses a guest key that is not 32 bytes", async () => {
    const clientKeys = await keys();
    const guestKeys = await keys();
    const shortKey = toBase64(new Uint8Array(31));
    stubFetch([() => json(200, readyStatus(clientKeys, guestKeys, { guestPublicKey: shortKey }))]);
    await expect(client().waitForReady(handleFor(clientKeys), 2_000)).rejects.toMatchObject({
      code: "invalid_guest_key",
    });
  });

  it("treats a rate-limited status call as retryable, not as the session's failure", async () => {
    const clientKeys = await keys();
    stubFetch([() => json(429, { error: "rate_limited", message: "slow down" })]);
    // A 429 never becomes the reported failure: the deadline is, and it says the
    // sandbox did not arrive in time rather than blaming the limiter.
    await expect(client().waitForReady(handleFor(clientKeys), 200)).rejects.toMatchObject({
      code: "ready_timeout",
    });
  });

  it("waits the Retry-After a rate-limited status call asked for", async () => {
    // The loop used to retry a 429 at its own 75ms pace, faster than the limiter
    // refills, so a client inside a rate limit stayed inside it. The header is
    // now a floor on the wait.
    const clientKeys = await keys();
    const guestKeys = await keys();
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "rate_limited", scope: "read" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "1" },
        });
      }
      return json(200, readyStatus(clientKeys, guestKeys));
    });

    const startedAt = Date.now();
    const status = await client().waitForReady(handleFor(clientKeys), 10_000);
    const elapsed = Date.now() - startedAt;

    expect(status.state).toBe("READY");
    expect(calls).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
  });

  it("answers ready_timeout when the deadline passes before READY", async () => {
    const clientKeys = await keys();
    const guestKeys = await keys();
    stubFetch([() => json(200, readyStatus(clientKeys, guestKeys, { state: "PROVISIONING" }))]);
    // A zero-wait deadline: the loop body never runs, so the answer is the
    // timeout rather than a status.
    await expect(client().waitForReady(handleFor(clientKeys), 0)).rejects.toMatchObject({ code: "ready_timeout" });
  });
});

describe("operation results", () => {
  async function resultFor(clientKeys: Keys, overrides: Record<string, unknown> = {}): Promise<string> {
    return sealJsonTo(clientKeys.publicKey, {
      v: 2,
      sessionId: SESSION_ID,
      clientNonce: NONCE,
      requestId: REQUEST_ID,
      op: "exec",
      ok: true,
      exitCode: 0,
      stdout: "hello",
      stderr: "",
      durationMs: 3,
      timedOut: false,
      cancelled: false,
      ...overrides,
    });
  }

  it("returns the decrypted result when the binding matches", async () => {
    const clientKeys = await keys();
    const guestKeys = await keys();
    stubFetch([() => json(200, { envelope: "" })]);
    const envelope = await resultFor(clientKeys);
    vi.unstubAllGlobals();
    stubFetch([() => json(200, { envelope })]);
    const result = await client().exec(handleFor(clientKeys, { guestPublicKey: guestKeys.publicKey }), {
      command: ["echo", "hello"],
      requestId: REQUEST_ID,
    });
    expect(result).toMatchObject({ ok: true, stdout: "hello" });
  });

  it("refuses a result sealed for another request id", async () => {
    const clientKeys = await keys();
    const guestKeys = await keys();
    const envelope = await resultFor(clientKeys, { requestId: "req-somebody-else" });
    stubFetch([() => json(200, { envelope })]);
    await expect(
      client().exec(handleFor(clientKeys, { guestPublicKey: guestKeys.publicKey }), {
        command: ["true"],
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "binding_mismatch" });
  });

  it("refuses a result it cannot decrypt with the client key", async () => {
    const clientKeys = await keys();
    const otherKeys = await keys();
    const guestKeys = await keys();
    const envelope = await resultFor(otherKeys);
    stubFetch([() => json(200, { envelope })]);
    await expect(
      client().exec(handleFor(clientKeys, { guestPublicKey: guestKeys.publicKey }), {
        command: ["true"],
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "decryption_failed" });
  });

  it("rejects a 200 with no envelope instead of returning an empty result", async () => {
    const clientKeys = await keys();
    const guestKeys = await keys();
    stubFetch([() => json(200, {})]);
    await expect(
      client().exec(handleFor(clientKeys, { guestPublicKey: guestKeys.publicKey }), {
        command: ["true"],
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "missing_result" });
  });

  it("surfaces a busy session as session_busy when the caller will not queue", async () => {
    const clientKeys = await keys();
    const guestKeys = await keys();
    stubFetch([() => json(409, { error: "busy", requestId: REQUEST_ID, message: "another operation is running" })]);
    await expect(
      client().exec(handleFor(clientKeys, { guestPublicKey: guestKeys.publicKey }), {
        command: ["true"],
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "session_busy", status: 409 });
  });

  it("returns the winner's result when the request id was already used", async () => {
    const clientKeys = await keys();
    const guestKeys = await keys();
    const envelope = await resultFor(clientKeys);
    stubFetch([
      () => json(409, { error: "duplicate", requestId: REQUEST_ID }),
      () => json(200, { envelope }),
    ]);
    const result = await client().exec(handleFor(clientKeys, { guestPublicKey: guestKeys.publicKey }), {
      command: ["true"],
      requestId: REQUEST_ID,
    });
    expect(result).toMatchObject({ ok: true, stdout: "hello" });
  });

  it("returns the pending operation when the poll window closes", async () => {
    const clientKeys = await keys();
    const guestKeys = await keys();
    // A negative timeout makes the client's own poll window zero, so the loop
    // exits without waiting. The server's wait cap is unaffected.
    stubFetch([() => json(202, { state: "READY", requestId: REQUEST_ID })]);
    const result = await client().exec(handleFor(clientKeys, { guestPublicKey: guestKeys.publicKey }), {
      command: ["sleep", "600"],
      requestId: REQUEST_ID,
      timeoutMs: -10_000,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: { code: string } }).error.code).toBe("operation_pending");
  });

  it("cancels nothing and reports the failure code the API gave for an unnamed error", async () => {
    const clientKeys = await keys();
    const guestKeys = await keys();
    stubFetch([() => json(500, { message: "no code here" })]);
    await expect(
      client().exec(handleFor(clientKeys, { guestPublicKey: guestKeys.publicKey }), {
        command: ["true"],
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "exec_failed", status: 500 });
  });
});

describe("file reads", () => {
  it("polls a 202 read and returns the result the guest sealed for it", async () => {
    const clientKeys = await keys();
    const guestKeys = await keys();
    let requestId = "";
    let polls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      const parsed = new URL(String(url));
      if (!requestId) {
        requestId = parsed.searchParams.get("requestId") ?? "";
        return json(202, { state: "READY", requestId });
      }
      polls += 1;
      const envelope = await sealJsonTo(clientKeys.publicKey, {
        v: 2,
        sessionId: SESSION_ID,
        clientNonce: NONCE,
        requestId,
        op: "file.get",
        ok: true,
        path: "/workspace/out.txt",
        dataBase64: Buffer.from("contents").toString("base64"),
        size: 8,
        archive: false,
      });
      return json(200, { envelope });
    });

    const result = await client().getFile(
      handleFor(clientKeys, { guestPublicKey: guestKeys.publicKey }),
      "/workspace/out.txt",
    );

    expect(polls).toBe(1);
    expect(result).toMatchObject({ ok: true, size: 8 });
    expect(Buffer.from((result as { dataBase64: string }).dataBase64, "base64").toString()).toBe("contents");
  });

  it("asks the GET surface with the sealed envelope in the query string", async () => {
    const clientKeys = await keys();
    const guestKeys = await keys();
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      return json(200, { envelope: "AAAA" });
    });
    await client()
      .getFile(handleFor(clientKeys, { guestPublicKey: guestKeys.publicKey }), "/workspace/out.txt")
      .catch((err: unknown) => err);
    expect(urls[0]).toContain(`/v1/sessions/${SESSION_ID}/operations?request=`);
    expect(urls[0]).toContain("requestId=");
    // The payload hash is what the controller binds idempotency to.
    expect(urls[0]).toContain("payloadHash=");
  });
});

describe("error mapping", () => {
  it("maps a 410 lease to a SessionExpiredError and keeps a 410 lookup distinct", async () => {
    const clientKeys = await keys();
    stubFetch([() => json(410, { error: "lease_expired", message: "gone" })]);
    const expired = await client()
      .status(handleFor(clientKeys))
      .catch((err: unknown) => err);
    expect(expired).toBeInstanceOf(SessionExpiredError);

    vi.unstubAllGlobals();
    stubFetch([() => json(410, {})]);
    await expect(client().getOperation(handleFor(clientKeys), REQUEST_ID, 0)).rejects.toMatchObject({
      code: "result_expired",
    });
  });

  it("carries the server's Retry-After on the error, so a caller can honour it", async () => {
    stubFetch([
      () =>
        new Response(JSON.stringify({ error: "rate_limited" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "2" },
        }),
    ]);
    const err = await client()
      .status(handleFor(await keys()))
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(SandboxError);
    expect(err).toMatchObject({ code: "rate_limited", status: 429, retryAfterMs: 2_000 });
  });

  it("sends the capability, never the handle's keys, on every request", async () => {
    const clientKeys = await keys();
    const seen: Array<Record<string, string>> = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return json(200, { sessionId: SESSION_ID, state: "READY" });
    });
    await client().status(handleFor(clientKeys));
    expect(seen[0]!["x-sandbox-capability"]).toBe("c".repeat(24));
    expect(JSON.stringify(seen[0])).not.toContain(toBase64(clientKeys.privateKey));
  });
});
