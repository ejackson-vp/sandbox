/**
 * Warm-pool security regression (real cluster).
 *
 * These assertions only run when the pool is enabled (WARM_POOL_SIZE>0), so
 * they are skipped on the default deployment:
 *   - a warm pod carries pool identity only, never a session id/key/nonce
 *   - a sandbox cannot use the relay's claim endpoint
 *   - every session gets fresh evidence bound to its own id, never the pool id
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStatus } from "../../shared/src/entries/protocol.js";
import { SandboxClient, FileSessionStore, type SessionHandle } from "../../sdk/src/index.js";
import { clusterAvailable, kubectl, kubectlTry } from "./kubectl.js";

const API = process.env.API_URL ?? "http://localhost:8080";
const available = clusterAvailable() && (await (async () => {
  try {
    return (await fetch(`${API}/healthz`)).ok;
  } catch {
    return false;
  }
})());

interface WarmPod {
  metadata: {
    name: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: {
    containers: Array<{ name: string; env?: Array<{ name: string; value?: string }> }>;
    initContainers?: Array<{ name: string; env?: Array<{ name: string; value?: string }> }>;
  };
}

function warmPods(): WarmPod[] {
  if (!available) return [];
  const res = kubectlTry(["-n", "sandbox-workloads", "get", "pods", "-l", "x402.io/pool=warm", "-o", "json"]);
  if (!res.ok) return [];
  return (JSON.parse(res.out) as { items: WarmPod[] }).items ?? [];
}

const pool = warmPods();
if (!available) {
  console.warn("\n[security] API/cluster not available: warm-pool tests are SKIPPED\n");
} else if (pool.length === 0) {
  console.warn("\n[security] warm pool is disabled (WARM_POOL_SIZE=0): warm-pool tests are SKIPPED\n");
}

const storeDir = mkdtempSync(join(tmpdir(), "x402-sec-warm-"));
const created: SessionHandle[] = [];
function makeClient(): SandboxClient {
  return new SandboxClient({
    apiUrl: API,
    paymentMode: "mock",
    allowInsecureDev: true,
    store: new FileSessionStore(storeDir),
    log: () => {},
  });
}

afterAll(async () => {
  for (const h of created) {
    try {
      await makeClient().destroy(h);
    } catch {
      /* best effort */
    }
  }
});

describe.skipIf(!available || pool.length === 0)("warm pool (real cluster)", () => {
  it("keeps session identity out of the warm pod", () => {
    for (const pod of pool) {
      expect(pod.metadata.labels?.["x402.io/pool"]).toBe("warm");
      expect(pod.metadata.labels?.["x402.io/warm-id"]).toMatch(/^[0-9a-f]{12}$/);
      expect(pod.metadata.labels?.["x402.io/session"]).toBeUndefined();
      // A pool pod is not a session pod, even though it shares the app label.
      expect(pod.metadata.name).toMatch(/^warm-/);

      const guest = pod.spec.containers.find((c) => c.name === "guest");
      expect(guest).toBeDefined();
      const env = new Map((guest?.env ?? []).map((e) => [e.name, e.value]));
      expect(env.get("WARM_MODE")).toBe("true");
      expect(env.get("POOL_ID")).toMatch(/^warm_[0-9a-f]{12}$/);
      expect(env.get("GUEST_IMAGE_DIGEST")).toMatch(/^sha256:/);
      expect(pod.metadata.annotations?.["x402.io/warm-identity"]).toMatch(/^[0-9a-f]{64}$/);
      expect(pod.metadata.annotations?.["x402.io/image-digest"]).toBe(env.get("GUEST_IMAGE_DIGEST"));
      for (const forbidden of ["SESSION_ID", "CLIENT_PUBLIC_KEY", "CLIENT_NONCE", "LEASE_SECONDS", "GUEST_TOKEN"]) {
        expect(env.has(forbidden)).toBe(false);
      }
    }
  }, 60_000);

  it("does not let a sandbox use the relay claim endpoint", async () => {
    const relayIp = kubectl(["-n", "sandbox-system", "get", "svc", "relay", "-o", "jsonpath={.spec.clusterIP}"]).trim();
    expect(relayIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

    const client = makeClient();
    const handle = await client.createSession({ tier: "short" });
    created.push(handle);
    await client.waitForReady(handle);
    const res = await client.exec(handle, {
      command: [
        "curl",
        "--noproxy",
        "*",
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--max-time",
        "5",
        "-X",
        "POST",
        `http://${relayIp}:8443/internal/warm_000000000000/claim`,
        "-H",
        "content-type: application/json",
        "-d",
        "{}",
      ],
      timeoutMs: 15_000,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(`exec failed: ${res.error?.code}`);
    // The legacy admin-token route is not mounted on the guest listener: control
    // routes live only on the mTLS listener (8444), which the sandbox cannot
    // reach. 404 proves the guest path has no control surface at all.
    expect(res.stdout.trim()).toBe("404");
  }, 240_000);

  it("gives each session fresh evidence bound to its own id", async () => {
    const client = makeClient();
    const statuses: SessionStatus[] = [];
    for (let i = 0; i < 2; i++) {
      const handle = await client.createSession({ tier: "short" });
      created.push(handle);
      const status = await client.waitForReady(handle);
      statuses.push(status);
      const att = status.attestation;
      expect(att).toBeDefined();
      expect(att?.sessionId).toBe(handle.sessionId);
      // The pool readiness hello is never the session's evidence.
      expect(att?.evidenceType).not.toBe("warm-pool");
      expect(att?.guestPublicKey).toMatch(/^[A-Za-z0-9+/=]{40,}$/);
      await client.destroy(handle);
    }
    // No key reuse across sessions, regardless of whether they hit the pool.
    expect(statuses[0]?.attestation?.guestPublicKey).not.toBe(statuses[1]?.attestation?.guestPublicKey);
  }, 300_000);
});
