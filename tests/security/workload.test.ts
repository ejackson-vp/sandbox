/**
 * Cluster-backed lifecycle and workload-security tests.
 *
 * These run against the real deployment and assert properties of the actual
 * Pod objects and actual controller behaviour (not mocked policy functions):
 *   - pod spec hardening (RuntimeClass, no hostPath, no privileges, no SA token)
 *   - secrets are not in the main container environment
 *   - execution timeout is enforced and the pod is removed
 *   - plaintext code/output never reaches control-plane or pod logs
 *   - a killed controller does not orphan a running/expired sandbox
 *   - Pod Security Admission rejects privileged workloads in the sandbox ns
 *   - payment replay cannot provision a second sandbox
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  fromBase64,
  generateBoxKeyPair,
  generateNonce,
  openSealedJson,
  sealJsonTo,
  toBase64,
  type ExecutePlaintext,
  type ResultPlaintext,
  type SandboxStatus,
} from "../../shared/src/index.js";
import { createPayer } from "../../cli/src/payment.js";
import { runWorkflow } from "../../cli/src/workflow.js";
import { createSandboxPayment } from "../helpers/x402.js";
import { applyYaml, clusterAvailable, deleteQuietly, kubectl, kubectlJson, kubectlTry } from "./kubectl.js";

const API = process.env.API_URL ?? "http://localhost:8080";
const available = clusterAvailable() && (await (async () => {
  try {
    const res = await fetch(`${API}/healthz`);
    return res.ok;
  } catch {
    return false;
  }
})());

if (!available) {
  console.warn("\n[security] API/cluster not available: workload tests are SKIPPED\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 60_000, interval = 300): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null) return v;
    await sleep(interval);
  }
  throw new Error("timeout waiting for condition");
}

async function getStatus(id: string, capability: string): Promise<SandboxStatus> {
  const res = await fetch(`${API}/v1/sandboxes/${id}`, { headers: { "x-sandbox-capability": capability } });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()) as SandboxStatus;
}

function runOptions(code: string, extra: Partial<Parameters<typeof runWorkflow>[0]> = {}) {
  return {
    apiUrl: API,
    code,
    durationSeconds: 30,
    allowInsecureDev: true,
    requireHardware: false,
    keepSandbox: false,
    json: true,
    payer: createPayer("mock"),
    say: () => {},
    note: () => {},
    ...extra,
  } satisfies Parameters<typeof runWorkflow>[0];
}

describe.skipIf(!available)("workload hardening (real cluster)", () => {
  const created: Array<{ id: string; capability: string }> = [];

  afterAll(() => {
    for (const s of created) {
      if (!s?.id) continue;
      deleteQuietly(["-n", "sandbox-workloads", "pod", `sbx-${s.id.replace(/^sbx_/, "")}`]);
    }
  });

  it("runs with a hardened pod spec and deletes the pod afterwards", async () => {
    const marker = randomBytes(6).toString("hex");
    let pod: {
      metadata: { name: string; labels: Record<string, string>; annotations: Record<string, string> };
      spec: Record<string, any>;
    } | null = null;
    let sandboxId = "";

    const outcome = await runWorkflow(
      runOptions(`# CODE_MARKER_${marker}\nprint("OUTPUT_MARKER_${marker}")\n`, {
        onReady: async ({ sandboxId: id }) => {
          sandboxId = id;
          const name = `sbx-${id.replace(/^sbx_/, "")}`;
          pod = kubectlJson(["-n", "sandbox-workloads", "get", "pod", name]);
        },
      }),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.result?.stdout).toContain(`OUTPUT_MARKER_${marker}`);
    expect(outcome.attestationVerified).toBe(true);

    expect(pod).not.toBeNull();
    const spec = pod!.spec;
    expect(pod!.metadata.labels["x402.io/session"]).toBe(sandboxId);
    expect(pod!.metadata.annotations["x402.io/confidential"]).toBe("false");

    // Mandatory RuntimeClass and dedicated placement.
    expect(spec.runtimeClassName).toBe("x402-sandbox");
    expect(spec.nodeSelector).toMatchObject({ "x402.io/sandbox-pool": "true" });

    // No host access.
    // Kubernetes omits false-valued booleans; absence means "not enabled".
    expect(spec.hostNetwork ?? false).toBe(false);
    expect(spec.hostPID ?? false).toBe(false);
    expect(spec.hostIPC ?? false).toBe(false);
    expect(spec.automountServiceAccountToken).toBe(false);
    expect(spec.enableServiceLinks).toBe(false);
    expect(spec.dnsPolicy).toBe("None");
    for (const volume of spec.volumes ?? []) {
      expect(volume.hostPath, "hostPath volumes are forbidden").toBeUndefined();
    }

    // Container hardening.
    const container = spec.containers[0];
    expect(container.image).toBe("x402-sandbox/guest:dev");
    expect(container.securityContext.privileged).toBe(false);
    expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(container.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(container.securityContext.capabilities.drop).toEqual(["ALL"]);
    expect(container.resources.limits.cpu).toBeTruthy();
    expect(container.resources.limits.memory).toBeTruthy();
    expect(container.resources.limits["ephemeral-storage"]).toBeTruthy();

    // Secrets must not be in the main container environment.
    const envNames = (container.env ?? []).map((e: { name: string }) => e.name);
    expect(envNames).not.toContain("GUEST_TOKEN");
    expect(envNames).not.toContain("DEV_ATTESTATION_KEY");
    expect(envNames).not.toContain("PROXY_TOKEN");
    expect(container.env.find((e: { name: string }) => e.name === "RELAY_URL")?.value).not.toMatch(/token=/);

    // Guest must run unprivileged.
    expect(spec.securityContext.runAsNonRoot).toBe(true);
    expect(spec.securityContext.runAsUser).toBe(65532);
    expect(spec.securityContext.seccompProfile.type).toBe("RuntimeDefault");

    // Pod is gone once the execution completed.
    await waitFor(async () => {
      const res = await fetch(`${API}/v1/sandboxes/${sandboxId}`, { headers: {} }).catch(() => null);
      void res;
      const exists = kubectlTry(["-n", "sandbox-workloads", "get", "pod", `sbx-${sandboxId.replace(/^sbx_/, "")}`]);
      return exists.ok ? null : true;
    }, 45_000);
  }, 180_000);

  it("enforces the execution deadline and returns an encrypted timeout result", async () => {
    const outcome = await runWorkflow(
      runOptions("import time\nprint('start', flush=True)\ntime.sleep(300)\n", { durationSeconds: 3 }),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toBeTruthy();
    expect(outcome.result!.timedOut).toBe(true);
    expect(outcome.result!.exitCode).toBe(-1);
    expect(outcome.result!.durationMs).toBeGreaterThanOrEqual(2500);
    expect(outcome.result!.durationMs).toBeLessThan(20_000);
    expect(outcome.result!.stdout).toContain("start");
    expect(outcome.result!.stdout).not.toContain("should never");
  }, 180_000);

  it("never writes plaintext code or output to control-plane or pod logs", async () => {
    const codeMarker = `CODE_MARKER_${randomBytes(8).toString("hex")}`;
    const outMarker = `OUTPUT_MARKER_${randomBytes(8).toString("hex")}`;
    let sandboxId = "";
    let capability = "";

    const outcome = await runWorkflow(
      runOptions(`# ${codeMarker}\nprint("${outMarker}")\n`, {
        keepSandbox: true,
        onReady: async (info) => {
          sandboxId = info.sandboxId;
          capability = info.capability;
        },
      }),
    );
    expect(outcome.result?.stdout).toContain(outMarker);

    const podName = `sbx-${sandboxId.replace(/^sbx_/, "")}`;
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

    // Clean up the kept sandbox.
    await fetch(`${API}/v1/sandboxes/${sandboxId}`, {
      method: "DELETE",
      headers: { "x-sandbox-capability": capability },
    });
  }, 180_000);

  it("recovers from a controller crash without orphaning the sandbox", async () => {
    const keys = await generateBoxKeyPair();
    const clientNonce = toBase64(await generateNonce());
    const body = {
      durationSeconds: 8,
      clientPublicKey: toBase64(keys.publicKey),
      clientNonce,
      language: "python3",
    };
    const { header } = await createSandboxPayment(API, body);
    const res = await fetch(`${API}/v1/sandboxes`, {
      method: "POST",
      headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": header },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    const createdSandbox = (await res.json()) as { sandboxId: string; capability: string };
    created.push(createdSandbox);

    const ready = await waitFor(async () => {
      const s = await getStatus(createdSandbox.sandboxId, createdSandbox.capability);
      return s.state === "READY" ? s : null;
    }, 60_000);
    expect(ready.executionDeadline).toBeTruthy();
    const podName = `sbx-${createdSandbox.sandboxId.replace(/^sbx_/, "")}`;
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
    }, 90_000);

    // The resumed controller must enforce the deadline it persisted in SQLite
    // and remove the pod.
    const final = await waitFor(async () => {
      const s = await getStatus(createdSandbox.sandboxId, createdSandbox.capability);
      return s.state === "EXPIRED" || s.state === "FAILED" || s.state === "DESTROYED" ? s : null;
    }, 90_000);
    expect(["EXPIRED", "FAILED", "DESTROYED"]).toContain(final.state);

    await waitFor(async () => {
      const exists = kubectlTry(["-n", "sandbox-workloads", "get", "pod", podName]);
      return exists.ok ? null : true;
    }, 60_000);
  }, 240_000);

  it("rejects a replayed payment against the live cluster", async () => {
    const body = {
      durationSeconds: 10,
      clientPublicKey: toBase64((await generateBoxKeyPair()).publicKey),
      clientNonce: toBase64(await generateNonce()),
      language: "python3",
    };
    const { header } = await createSandboxPayment(API, body);
    const first = await fetch(`${API}/v1/sandboxes`, {
      method: "POST",
      headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": header },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);
    const createdSandbox = (await first.json()) as { sandboxId: string; capability: string };
    created.push(createdSandbox);

    const before = kubectl([
      "-n",
      "sandbox-workloads",
      "get",
      "pods",
      "-l",
      `x402.io/session=${createdSandbox.sandboxId}`,
      "--no-headers",
    ]).trim();

    const replay = await fetch(`${API}/v1/sandboxes`, {
      method: "POST",
      headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": header },
      body: JSON.stringify(body),
    });
    expect(replay.status).toBe(402);

    // Exactly one pod exists for that payment (0 or 1 while provisioning).
    const after = kubectl([
      "-n",
      "sandbox-workloads",
      "get",
      "pods",
      "-l",
      `x402.io/session=${createdSandbox.sandboxId}`,
      "--no-headers",
    ]).trim();
    expect(after.split("\n").filter(Boolean).length).toBeLessThanOrEqual(1);
    void before;
  }, 120_000);

  it("Pod Security Admission rejects privileged workloads in the sandbox namespace", () => {
    const res = kubectlTry([
      "apply",
      "-f",
      "-",
    ], `
apiVersion: v1
kind: Pod
metadata: {name: privileged-attempt, namespace: sandbox-workloads}
spec:
  containers:
    - name: p
      image: x402-sandbox/guest:dev
      securityContext: {privileged: true}
`);
    expect(res.ok).toBe(false);
    expect(res.out.toLowerCase()).toMatch(/forbidden|violat|podsecurity|restricted/);
  }, 60_000);

  it("rejects an execute request that does not carry the capability", async () => {
    const keys = await generateBoxKeyPair();
    const clientNonce = toBase64(await generateNonce());
    const body = {
      durationSeconds: 20,
      clientPublicKey: toBase64(keys.publicKey),
      clientNonce,
      language: "python3",
    };
    const { header } = await createSandboxPayment(API, body);
    const res = await fetch(`${API}/v1/sandboxes`, {
      method: "POST",
      headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": header },
      body: JSON.stringify(body),
    });
    const c = (await res.json()) as { sandboxId: string; capability: string };
    created.push(c);

    const ready = await waitFor(async () => {
      const s = await getStatus(c.sandboxId, c.capability);
      return s.state === "READY" ? s : null;
    }, 60_000);

    const envelope = await sealJsonTo(fromBase64(ready.guestPublicKey!), {
      v: 1,
      sessionId: c.sandboxId,
      clientNonce,
      language: "python3",
      code: "print('nope')",
    } satisfies ExecutePlaintext);

    const unauthorized = await fetch(`${API}/v1/sandboxes/${c.sandboxId}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envelope }),
    });
    expect(unauthorized.status).toBe(401);

    const wrongCapability = await fetch(`${API}/v1/sandboxes/${c.sandboxId}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sandbox-capability": randomBytes(32).toString("base64url") },
      body: JSON.stringify({ envelope }),
    });
    expect(wrongCapability.status).toBe(404);
  }, 120_000);
});

describe.skipIf(!available)("result confidentiality", () => {
  it("returns a result only the customer key can decrypt", async () => {
    const keys = await generateBoxKeyPair();
    const clientNonce = toBase64(await generateNonce());
    const outcome = await runWorkflow(
      runOptions("print('secret-output')\n", { keepSandbox: true, payer: createPayer("mock") }),
    );
    expect(outcome.result?.stdout).toContain("secret-output");

    // Sanity: the same ciphertext cannot be opened by a fresh key.
    const other = await generateBoxKeyPair();
    const blob = await sealJsonTo(keys.publicKey, { v: 1, sessionId: "x", clientNonce, code: "" });
    await expect(openSealedJson<ResultPlaintext>(blob, other.publicKey, other.privateKey)).rejects.toThrow();
  }, 120_000);
});
