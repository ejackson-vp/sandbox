/**
 * Cluster-backed lifecycle and workload-security tests.
 *
 * These run against the real deployment and assert properties of the actual Pod
 * objects and actual controller behaviour (not mocked policy functions):
 *   - pod spec hardening and per-tier resource limits
 *   - secrets are not in the main container environment
 *   - per-command timeouts, lease expiration and cleanup
 *   - plaintext code/output never reaches control-plane or pod logs
 *   - a killed controller does not orphan a running/expired session
 *   - Pod Security Admission rejects privileged workloads
 *   - payment replay cannot provision a second session
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStatus } from "../../shared/src/index.js";
import { SandboxClient, FileSessionStore } from "../../sdk/src/index.js";
import { createSessionPayment } from "../helpers/x402.js";
import { clusterAvailable, deleteQuietly, kubectl, kubectlJson, kubectlTry } from "./kubectl.js";

const API = process.env.API_URL ?? "http://localhost:8080";
const available = clusterAvailable() && (await (async () => {
  try {
    return (await fetch(`${API}/healthz`)).ok;
  } catch {
    return false;
  }
})());

if (!available) {
  console.warn("\n[security] API/cluster not available: workload tests are SKIPPED\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const storeDir = mkdtempSync(join(tmpdir(), "x402-sec-sessions-"));

function makeClient(): SandboxClient {
  return new SandboxClient({
    apiUrl: API,
    paymentMode: "mock",
    allowInsecureDev: true,
    store: new FileSessionStore(storeDir),
    log: () => {},
  });
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 90_000, interval = 300): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null) return v;
    await sleep(interval);
  }
  throw new Error("timeout waiting for condition");
}

async function rawStatus(id: string, capability: string): Promise<SessionStatus | null> {
  const res = await fetch(`${API}/v1/sessions/${id}`, { headers: { "x-sandbox-capability": capability } });
  if (!res.ok) return null;
  return (await res.json()) as SessionStatus;
}

async function podExists(sessionId: string): Promise<boolean> {
  return kubectlTry(["-n", "sandbox-workloads", "get", "pod", `sbx-${sessionId.replace(/^sbx_/, "")}`]).ok;
}

const created: Array<{ id: string; capability: string }> = [];

afterAll(() => {
  for (const s of created) {
    if (!s?.id) continue;
    deleteQuietly(["-n", "sandbox-workloads", "pod", `sbx-${s.id.replace(/^sbx_/, "")}`]);
  }
});

describe.skipIf(!available)("workload hardening (real cluster)", () => {
  it("runs with a hardened pod spec, correct limits, and removes the pod", async () => {
    const client = makeClient();
    const handle = await client.createSession({ tier: "standard" });
    created.push({ id: handle.sessionId, capability: handle.capability });
    await client.waitForReady(handle);

    const pod = kubectlJson<{
      metadata: { labels: Record<string, string>; annotations: Record<string, string> };
      spec: Record<string, any>;
    }>(["-n", "sandbox-workloads", "get", "pod", `sbx-${handle.sessionId.replace(/^sbx_/, "")}`]);

    const spec = pod.spec;
    expect(pod.metadata.labels["x402.io/session"]).toBe(handle.sessionId);
    expect(pod.metadata.annotations["x402.io/confidential"]).toBe("false");
    expect(pod.metadata.annotations["x402.io/lease-seconds"]).toBe("300");
    expect(spec.runtimeClassName).toBe("x402-sandbox");
    expect(spec.nodeSelector).toMatchObject({ "x402.io/sandbox-pool": "true" });

    // No host access and no credentials.
    expect(spec.hostNetwork ?? false).toBe(false);
    expect(spec.hostPID ?? false).toBe(false);
    expect(spec.hostIPC ?? false).toBe(false);
    expect(spec.automountServiceAccountToken).toBe(false);
    expect(spec.enableServiceLinks).toBe(false);
    expect(spec.dnsPolicy).toBe("None");
    for (const volume of spec.volumes ?? []) expect(volume.hostPath).toBeUndefined();

    const container = spec.containers[0];
    expect(container.image).toBe("x402-sandbox/guest:dev");
    expect(container.securityContext.privileged).toBe(false);
    expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(container.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(container.securityContext.capabilities.drop).toEqual(["ALL"]);
    // Tier limits are mirrored into Kubernetes resource limits.
    expect(["1", "1000m"]).toContain(container.resources.limits.cpu);
    expect(["1024Mi", "1Gi"]).toContain(container.resources.limits.memory);
    expect(container.resources.limits["ephemeral-storage"]).toBeTruthy();
    // The scheduler packs by the baseline; the limits remain the burst ceiling.
    expect(container.resources.requests.cpu).toBe("250m");
    expect(container.resources.requests.memory).toBe("256Mi");

    const envNames = (container.env ?? []).map((e: { name: string }) => e.name);
    for (const forbidden of ["GUEST_TOKEN", "DEV_ATTESTATION_KEY", "PROXY_TOKEN"]) {
      expect(envNames).not.toContain(forbidden);
    }
    expect(container.env.find((e: { name: string }) => e.name === "RELAY_URL")?.value).not.toMatch(/token=/);
    expect(spec.securityContext.runAsNonRoot).toBe(true);
    expect(spec.securityContext.runAsUser).toBe(65532);

    const run = await client.exec(handle, { command: ["echo", "hardened"] });
    expect(run.ok).toBe(true);

    // Customer code must not see management credentials or the bootstrap file.
    const creds = await client.exec(handle, {
      command: ["bash", "-c", 'env | grep -E "GUEST_TOKEN|DEV_ATTESTATION_KEY|PROXY_TOKEN" | wc -l'],
    });
    expect(creds.ok && creds.stdout.trim()).toBe("0");
    const bootstrap = await client.exec(handle, {
      command: ["bash", "-c", "test -e /run/x402/bootstrap.json && echo present || echo absent"],
    });
    expect(bootstrap.ok && bootstrap.stdout.trim()).toBe("absent");
    const environ = await client.exec(handle, {
      command: ["bash", "-c", 'tr "\\0" "\\n" < /proc/1/environ | grep -cE "GUEST_TOKEN|DEV_ATTESTATION_KEY" || true'],
    });
    expect(environ.ok && environ.stdout.trim()).toBe("0");

    const destroyed = await client.destroy(handle);
    expect(destroyed?.state).toBe("DESTROYED");
    await waitFor(async () => ((await podExists(handle.sessionId)) ? null : true), 45_000);
  }, 240_000);

  it("enforces a per-command timeout inside the cluster", async () => {
    const client = makeClient();
    const handle = await client.createSession({ tier: "standard" });
    created.push({ id: handle.sessionId, capability: handle.capability });
    await client.waitForReady(handle);
    const result = await client.exec(handle, {
      command: ["bash", "-c", "echo start; sleep 300"],
      timeoutMs: 3000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.timedOut).toBe(true);
      expect(result.durationMs).toBeLessThan(20_000);
      expect(result.stdout).toContain("start");
    }
    // Session remains usable after a timeout.
    const after = await client.exec(handle, { command: ["echo", "alive"] });
    expect(after.ok && after.stdout.trim() === "alive").toBe(true);
    await client.destroy(handle);
  }, 240_000);

  it("never writes plaintext commands or output to control-plane or pod logs", async () => {
    const client = makeClient();
    const handle = await client.createSession({ tier: "standard" });
    created.push({ id: handle.sessionId, capability: handle.capability });
    await client.waitForReady(handle);

    const codeMarker = `CODE_MARKER_${randomBytes(8).toString("hex")}`;
    const outMarker = `OUTPUT_MARKER_${randomBytes(8).toString("hex")}`;
    const result = await client.exec(handle, {
      command: ["bash", "-c", `# ${codeMarker}\necho ${outMarker}`],
    });
    expect(result.ok && result.stdout.includes(outMarker)).toBe(true);

    const podName = `sbx-${handle.sessionId.replace(/^sbx_/, "")}`;
    const slurp = (args: string[]) => kubectlTry(args).out;
    const sources = [
      slurp(["-n", "sandbox-workloads", "logs", podName, "--tail=-1"]),
      slurp(["-n", "sandbox-system", "logs", "-l", "app=api", "--tail=-1"]),
      slurp(["-n", "sandbox-system", "logs", "-l", "app=controller", "--tail=-1"]),
      slurp(["-n", "sandbox-system", "logs", "-l", "app=relay", "--tail=-1"]),
      slurp(["-n", "sandbox-system", "logs", "-l", "app=egress-proxy", "--tail=-1"]),
      slurp(["-n", "sandbox-system", "logs", "-l", "app=facilitator", "--tail=-1"]),
    ].join("\n");
    expect(sources).not.toContain(codeMarker);
    expect(sources).not.toContain(outMarker);

    await client.destroy(handle);
  }, 240_000);

  it("recovers from a controller crash without orphaning the session", async () => {
    const client = makeClient();
    const handle = await client.createSession({ tier: "custom", durationSeconds: 12 });
    created.push({ id: handle.sessionId, capability: handle.capability });
    await client.waitForReady(handle);
    const podName = `sbx-${handle.sessionId.replace(/^sbx_/, "")}`;
    expect(kubectlTry(["-n", "sandbox-workloads", "get", "pod", podName]).ok).toBe(true);

    // Crash the controller exactly as an OOM kill / node failure would.
    kubectl(["-n", "sandbox-system", "delete", "pod", "-l", "app=controller", "--grace-period=0", "--force"]);
    await waitFor(async () => {
      const pods = kubectlJson<{ items: Array<{ status: { phase: string; containerStatuses?: Array<{ ready: boolean }> } }> }>([
        "-n",
        "sandbox-system",
        "get",
        "pods",
        "-l",
        "app=controller",
      ]);
      const p = pods.items[0];
      return p && p.status.phase === "Running" && p.status.containerStatuses?.[0]?.ready ? true : null;
    }, 120_000);

    const final = await waitFor(async () => {
      const status = await rawStatus(handle.sessionId, handle.capability);
      return status && ["EXPIRED", "FAILED", "DESTROYED"].includes(status.state) ? status : null;
    }, 120_000);
    expect(["EXPIRED", "FAILED", "DESTROYED"]).toContain(final.state);
    await waitFor(async () => ((await podExists(handle.sessionId)) ? null : true), 60_000);
  }, 300_000);

  it("removes the workspace when a session is destroyed", async () => {
    const client = makeClient();
    const handle = await client.createSession({ tier: "custom", durationSeconds: 60 });
    created.push({ id: handle.sessionId, capability: handle.capability });
    await client.waitForReady(handle);
    const put = await client.putFile(handle, { path: "/workspace/secret.txt", data: Buffer.from("ephemeral") });
    expect(put.ok).toBe(true);
    await client.destroy(handle);
    await waitFor(async () => ((await podExists(handle.sessionId)) ? null : true), 45_000);
    // Workspace is an emptyDir: it is deleted with the pod. No PV is mounted.
    const pod = kubectlTry(["-n", "sandbox-workloads", "get", "pod", `sbx-${handle.sessionId.replace(/^sbx_/, "")}`]);
    expect(pod.ok).toBe(false);
  }, 180_000);

  it("rejects a replayed payment against the live cluster", async () => {
    const keys = await import("../../shared/src/index.js").then(async (m) => {
      const kp = await m.generateBoxKeyPair();
      return { clientPublicKey: m.toBase64(kp.publicKey), clientNonce: m.toBase64(await m.generateNonce()) };
    });
    const body = { tier: "short", clientPublicKey: keys.clientPublicKey, clientNonce: keys.clientNonce };
    const { header } = await createSessionPayment(API, body);
    const post = () =>
      fetch(`${API}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": header },
        body: JSON.stringify(body),
      });
    const first = await post();
    expect(first.status).toBe(201);
    const createdSession = (await first.json()) as { sessionId: string; capability: string };
    created.push({ id: createdSession.sessionId, capability: createdSession.capability });

    const replay = await post();
    expect(replay.status).toBe(200);
    const replayed = (await replay.json()) as { sessionId: string };
    expect(replayed.sessionId).toBe(createdSession.sessionId);
    // Exactly one pod may exist for that payment (after provisioning starts).
    await waitFor(async () => (storeSessionsFor(createdSession.sessionId) > 0 ? true : null), 45_000);
    expect(storeSessionsFor(createdSession.sessionId)).toBe(1);
  }, 180_000);

  it("Pod Security Admission rejects privileged workloads in the sandbox namespace", () => {
    const res = kubectlTry(
      ["apply", "-f", "-"],
      `
apiVersion: v1
kind: Pod
metadata: {name: privileged-attempt, namespace: sandbox-workloads}
spec:
  containers:
    - name: p
      image: x402-sandbox/guest:dev
      securityContext: {privileged: true}
`,
    );
    expect(res.ok).toBe(false);
    expect(res.out.toLowerCase()).toMatch(/forbidden|violat|podsecurity|restricted/);
  }, 60_000);

  it("rejects operations without the session capability", async () => {
    const client = makeClient();
    const handle = await client.createSession({ tier: "custom", durationSeconds: 60 });
    created.push({ id: handle.sessionId, capability: handle.capability });
    await client.waitForReady(handle);

    const noCap = await fetch(`${API}/v1/sessions/${handle.sessionId}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "no-capability-01", envelope: "AAAA" }),
    });
    expect(noCap.status).toBe(401);

    const wrongCap = await fetch(`${API}/v1/sessions/${handle.sessionId}/exec`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sandbox-capability": randomBytes(32).toString("base64url"),
      },
      body: JSON.stringify({ requestId: "wrong-capability-01", envelope: "AAAA" }),
    });
    expect(wrongCap.status).toBe(404);
  }, 180_000);
});

function storeSessionsFor(sessionId: string): number {
  const pods = kubectl([
    "-n",
    "sandbox-workloads",
    "get",
    "pods",
    "-l",
    `x402.io/session=${sessionId}`,
    "--no-headers",
  ]).trim();
  return pods.split("\n").filter(Boolean).length;
}
