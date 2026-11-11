/**
 * Guest protocol negotiation and the server-side measurement pin.
 *
 * The controller and the guest are separate artifacts, so both gates must be
 * one-sided in the safe direction: a hello that predates the version field is
 * accepted (a rollout leaves warm pools full of old images), and the
 * measurement allowlist only verifies when an operator configured one.
 */
import { describe, expect, it, vi } from "vitest";
import { createPrivateKey, sign } from "node:crypto";
import type { WebSocket } from "ws";
import {
  canonicalEvidenceBytes,
  DEV_ATTESTATION_KEY_ID,
  GUEST_PROTOCOL_VERSION,
  MetricsRegistry,
  MIN_SUPPORTED_GUEST_PROTOCOL_VERSION,
  supportsGuestProtocolVersion,
  type AttestationEnvelope,
} from "../../shared/src/index.js";
import { loadControllerConfig } from "../../controller/src/config.js";
import { Provisioning } from "../../controller/src/provisioning.js";
import { RelayRegistry } from "../../controller/src/relay/registry.js";
import type { SessionRecord, Store } from "../../controller/src/store.js";
import type { WarmPoolManager } from "../../controller/src/warm-pool-manager.js";

const SESSION_ID = "sbx_guest_protocol_0001";
const NONCE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const CLIENT_KEY = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=";
const MEASUREMENT = "a".repeat(64);
const OTHER_MEASUREMENT = "b".repeat(64);
const SEED_B64 = "qSgP+dPwGhb/58O0ZD/dSqCMovhhWNIQbT3MeTD35WY=";
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function signEnvelope(env: AttestationEnvelope): AttestationEnvelope {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(SEED_B64, "base64")]),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(null, canonicalEvidenceBytes(env), key).toString("base64");
  return { ...env, signature: { alg: "ed25519", keyId: DEV_ATTESTATION_KEY_ID, value: signature } };
}

function evidence(overrides: Partial<AttestationEnvelope> = {}): AttestationEnvelope {
  const now = Date.now();
  return signEnvelope({
    v: 1,
    evidenceType: "dev-simulated",
    insecureDevOnly: true,
    hardwareBacked: false,
    sessionId: SESSION_ID,
    guestPublicKey: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA=",
    clientPublicKey: CLIENT_KEY,
    clientNonce: NONCE,
    bootNonce: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA=",
    issuedAt: now - 1_000,
    expiresAt: now + 60_000,
    claims: {
      guestMeasurement: MEASUREMENT,
      imageDigest: "sha256:test",
      runtimeClass: "x402-sandbox",
      hardwareBacked: false,
      guestPolicyEnforced: false,
    },
    report: "",
    signature: { alg: "ed25519", keyId: DEV_ATTESTATION_KEY_ID, value: "" },
    ...overrides,
  });
}

function registry(): RelayRegistry {
  return new RelayRegistry({
    maxSessions: 4,
    responseTtlMs: 60_000,
    metricsRegistry: new MetricsRegistry({ cacheMs: 0 }),
  });
}

function connect(sessions: RelayRegistry): void {
  sessions.register(SESSION_ID, "hash", 60_000);
  const socket = { readyState: 1, send: () => undefined, terminate: () => undefined } as unknown as WebSocket;
  sessions.attach(SESSION_ID, socket);
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: SESSION_ID,
    // awaitReady only ever sees a row the reconciler picked in PROVISIONING or
    // RESUMING, and both writes (setProvisioning, markResuming) set the pod
    // name, so the fixture carries one. The transition table refuses a
    // guest_ready without a pod and a relay entry.
    state: "PROVISIONING",
    durationSeconds: 300,
    limits: {
      cpuMillis: 500,
      memoryMiB: 512,
      diskMiB: 256,
      maxOutputBytes: 1_048_576,
      maxFileBytes: 1_048_576,
      maxCommandSeconds: 300,
      maxProcesses: 64,
    },
    clientPublicKey: CLIENT_KEY,
    clientNonce: NONCE,
    paidAt: Date.now(),
    timingsJson: null,
    relayTokenHash: "token-hash",
    podName: "sbx-guest-protocol-0001",
    ...overrides,
  } as unknown as SessionRecord;
}

function config(allowlist?: string) {
  return loadControllerConfig({
    ADMIN_TOKEN: "p".repeat(24),
    ROLE: "all",
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
    KUBERNETES_ENABLED: "false",
    DB_PATH: ":memory:",
    RELAY_ADMIN_TOKEN: "r".repeat(24),
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "proxy-secret-0123456789",
    ...(allowlist ? { GUEST_MEASUREMENT_ALLOWLIST: allowlist } : {}),
  });
}

interface Harness {
  provisioning: Provisioning;
  store: { requestTermination: ReturnType<typeof vi.fn>; setReady: ReturnType<typeof vi.fn>; mergeTimings: ReturnType<typeof vi.fn> };
}

function harness(opts: {
  allowlist?: string;
  protocolVersion?: number;
  attestation?: AttestationEnvelope;
}): Harness {
  const store = {
    requestTermination: vi.fn(() => true),
    setReady: vi.fn(() => true),
    mergeTimings: vi.fn(),
  };
  const state = {
    registered: true,
    connected: true,
    pending: 0,
    attestation: opts.attestation ?? evidence(),
    helloAt: Date.now(),
    ...(opts.protocolVersion !== undefined ? { protocolVersion: opts.protocolVersion } : {}),
  };
  const relay = {
    isReady: vi.fn(async () => true),
    health: vi.fn(async () => ({ ok: true, generation: "g" })),
    healthFor: vi.fn(async () => ({ ok: true, generation: "g" })),
    state: vi.fn(async () => state),
  };
  const provisioning = new Provisioning(
    {
      cfg: config(opts.allowlist),
      store: store as unknown as Store,
      // A PROVISIONING row carries a pod name, so awaitReady probes it. There
      // is no pod to read in this harness, which is a normal miss.
      provisioner: { getPod: vi.fn(async () => null) } as never,
      relay: relay as never,
      capacity: {} as never,
      snapshotter: {} as never,
      now: () => Date.now(),
      serviceAddress: vi.fn(async () => null),
    },
    {} as WarmPoolManager,
  );
  return { provisioning, store };
}

describe("guest protocol version", () => {
  it("treats an absent version as the minimum supported", () => {
    expect(MIN_SUPPORTED_GUEST_PROTOCOL_VERSION).toBeGreaterThan(0);
    expect(GUEST_PROTOCOL_VERSION).toBeGreaterThanOrEqual(MIN_SUPPORTED_GUEST_PROTOCOL_VERSION);
    expect(supportsGuestProtocolVersion(undefined)).toBe(true);
    expect(supportsGuestProtocolVersion(MIN_SUPPORTED_GUEST_PROTOCOL_VERSION)).toBe(true);
  });

  it("accepts the current and newer versions, rejects only below the floor", () => {
    expect(supportsGuestProtocolVersion(GUEST_PROTOCOL_VERSION)).toBe(true);
    // A newer image can reach a warm pool before the controller is upgraded.
    expect(supportsGuestProtocolVersion(GUEST_PROTOCOL_VERSION + 1)).toBe(true);
    expect(supportsGuestProtocolVersion(MIN_SUPPORTED_GUEST_PROTOCOL_VERSION - 1)).toBe(false);
    expect(supportsGuestProtocolVersion(0)).toBe(false);
    expect(supportsGuestProtocolVersion(-1)).toBe(false);
    expect(supportsGuestProtocolVersion(1.5)).toBe(false);
  });

  it("records hello metadata and exposes it through the state view", () => {
    const sessions = registry();
    connect(sessions);
    expect(sessions.hello(SESSION_ID, evidence(), { protocolVersion: GUEST_PROTOCOL_VERSION, capabilities: ["exec", "file.get"] })).toBe(true);

    expect(sessions.state(SESSION_ID)).toMatchObject({
      protocolVersion: GUEST_PROTOCOL_VERSION,
      capabilities: ["exec", "file.get"],
    });
  });

  it("leaves the fields absent for a pre-versioning guest", () => {
    const sessions = registry();
    connect(sessions);
    expect(sessions.hello(SESSION_ID, evidence())).toBe(true);

    const state = sessions.state(SESSION_ID);
    expect("protocolVersion" in state).toBe(false);
    expect("capabilities" in state).toBe(false);
  });

  it("does not inherit metadata from a previous guest process", () => {
    const sessions = registry();
    connect(sessions);
    sessions.hello(SESSION_ID, evidence(), { protocolVersion: GUEST_PROTOCOL_VERSION, capabilities: ["exec"] });
    sessions.remove(SESSION_ID);

    connect(sessions);
    sessions.hello(SESSION_ID, evidence());
    expect(sessions.state(SESSION_ID).protocolVersion).toBeUndefined();
  });

  it("fails a session below the floor before READY", async () => {
    const { provisioning, store } = harness({ protocolVersion: MIN_SUPPORTED_GUEST_PROTOCOL_VERSION - 1 });
    await provisioning.awaitReady(session());

    expect(store.setReady).not.toHaveBeenCalled();
    expect(store.requestTermination).toHaveBeenCalledWith(
      SESSION_ID,
      "failure:guest_protocol_unsupported",
      expect.objectContaining({ code: "guest_protocol_unsupported" }),
    );
  });

  it("reaches READY for a versionless guest", async () => {
    const { provisioning, store } = harness({});
    await provisioning.awaitReady(session());

    expect(store.requestTermination).not.toHaveBeenCalled();
    expect(store.setReady).toHaveBeenCalledOnce();
  });
});

describe("server-side measurement pin", () => {
  it("accepts a hello whose measurement is in the allowlist", async () => {
    const { provisioning, store } = harness({ allowlist: MEASUREMENT });
    await provisioning.awaitReady(session());

    expect(store.requestTermination).not.toHaveBeenCalled();
    expect(store.setReady).toHaveBeenCalledOnce();
  });

  it("refuses a hello whose measurement is not in the allowlist", async () => {
    const { provisioning, store } = harness({ allowlist: OTHER_MEASUREMENT });
    await provisioning.awaitReady(session());

    expect(store.setReady).not.toHaveBeenCalled();
    expect(store.requestTermination).toHaveBeenCalledWith(
      SESSION_ID,
      "failure:guest_measurement_not_allowed",
      expect.objectContaining({ code: "guest_measurement_not_allowed" }),
    );
  });

  it("uses the shared verifier, so bad evidence fails closed when pinned", async () => {
    const tampered = evidence({ clientNonce: "not-the-session-nonce" });
    const { provisioning, store } = harness({ allowlist: MEASUREMENT, attestation: tampered });
    await provisioning.awaitReady(session());

    expect(store.setReady).not.toHaveBeenCalled();
    expect(store.requestTermination).toHaveBeenCalledWith(
      SESSION_ID,
      "failure:guest_attestation_rejected",
      expect.objectContaining({ code: "guest_attestation_rejected" }),
    );
  });

  it("does not verify at all when no allowlist is configured", async () => {
    // Unsigned evidence would fail any verification. It must still reach READY:
    // unset means the behaviour that existed before this option.
    const unsigned = evidence({ signature: { alg: "ed25519", keyId: DEV_ATTESTATION_KEY_ID, value: "not-a-signature" } });
    const { provisioning, store } = harness({ attestation: unsigned });
    await provisioning.awaitReady(session());

    expect(store.requestTermination).not.toHaveBeenCalled();
    expect(store.setReady).toHaveBeenCalledOnce();
  });

  it("parses the allowlist as lowercase sha256 hex and fails startup on a typo", () => {
    expect(config(`${MEASUREMENT.toUpperCase()}, ${OTHER_MEASUREMENT}`).guestMeasurementAllowlist).toEqual([
      MEASUREMENT,
      OTHER_MEASUREMENT,
    ]);
    expect(config().guestMeasurementAllowlist).toEqual([]);
    expect(() => config("not-hex")).toThrow(/GUEST_MEASUREMENT_ALLOWLIST/);
  });
});
