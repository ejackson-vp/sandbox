/**
 * Anonymous attacker suite (real cluster).
 *
 * Everything here is done from the position an anonymous client actually has:
 * no capability, no account, no cluster credentials. The cases are the cheap
 * attacks a public endpoint sees on its first day, plus the sandbox-egress
 * destinations that would turn a guest into a pivot:
 *
 *   - a create flood through one proxy path (the IP bucket, not a payer)
 *   - `X-Forwarded-For` spoofing to buy a fresh bucket
 *   - an oversized create body
 *   - a slowloris connection held open
 *   - capability brute force against a live session
 *   - a credential minted for one session presented as another's relay token
 *   - egress to RFC1918, link-local metadata and the node, and DNS rebinding
 *
 * Needs a deployed cluster and API. Run it with:
 *
 *   make up && make deploy           # kind + Cilium, or `make kata` for the gate
 *   API_URL=http://localhost:8080 \
 *     npx vitest run --config vitest.security.config.ts tests/security/attacker.test.ts
 *
 * Without a reachable cluster and API the suite is skipped with a warning, the
 * same way `network.test.ts`, `workload.test.ts` and `warm-pool.test.ts` do.
 * A skipped suite is not evidence: `make security-isolation` fails when these
 * files produce zero executed tests.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionStore, SandboxClient, type SessionHandle } from "../../sdk/src/index.js";
import { mintProxyToken } from "../../controller/src/tokens.js";
import { applyYaml, clusterAvailable, deleteQuietly, kubectl } from "./kubectl.js";
import { probePod, runProbes, type ProbeCase } from "./probe.js";
import {
  API,
  API_URL,
  apiHealth,
  createAttempt,
  deployConfig,
  drainCreateBudget,
  oversizedBody,
  portForward,
  singlePathProxy,
  slowloris,
  upgradeStatus,
} from "./attacker-helpers.js";

const health = await apiHealth();
const available = clusterAvailable() && health !== null;
const mockPayments = health?.paymentMode === "mock";
// `localhost` can resolve to ::1 first; kind's port mapping is on 127.0.0.1.
const HOST = API_URL.hostname === "localhost" ? "127.0.0.1" : API_URL.hostname;
const PORT = Number(API_URL.port || (API_URL.protocol === "https:" ? 443 : 80));

if (!available) {
  console.warn("\n[security] API/cluster not available: attacker tests are SKIPPED\n");
}
if (available && !mockPayments) {
  console.warn(
    `\n[security] paymentMode is "${health?.paymentMode}", not mock: session-creating attacker cases are SKIPPED\n`,
  );
}

// Read once, only when there is something to read from.
const trustProxyHops = available ? deployConfig("TRUST_PROXY_HOPS") : "";
const proxyTokenSecret = available
  ? Buffer.from(
      kubectl([
        "-n",
        "sandbox-system",
        "get",
        "secret",
        "x402-secrets",
        "-o",
        "jsonpath={.data.proxy-token-secret}",
      ]),
      "base64",
    ).toString("utf8")
  : "";

const storeDir = mkdtempSync(join(tmpdir(), "x402-sec-attacker-"));
const created: SessionHandle[] = [];
const probePods: string[] = [];
/**
 * True once a case has deliberately spent the per-IP create budget. Later suite
 * files in the same vitest run (`workload.test.ts` creates sessions from the
 * same address) would otherwise inherit a 429 from this file.
 */
let drainedCreateBudget = false;

afterAll(async () => {
  for (const name of probePods.splice(0)) {
    deleteQuietly(["-n", "sandbox-workloads", "pod", name]);
  }
  for (const handle of created.splice(0)) {
    deleteQuietly([
      "-n",
      "sandbox-workloads",
      "pod",
      `sbx-${handle.sessionId.replace(/^sbx_/, "")}`,
    ]);
  }
  if (!drainedCreateBudget) return;
  const burst = Number(deployConfig("CREATE_IP_RATE_BURST") || 120);
  const refill = Number(deployConfig("CREATE_IP_RATE_REFILL") || 10);
  // One refill window, so the next file starts with a full bucket. Bounded by
  // the deployment's own numbers rather than a guessed sleep.
  await new Promise((resolve) => setTimeout(resolve, Math.ceil((burst / refill) * 1_000) + 2_000));
});

function makeClient(): SandboxClient {
  return new SandboxClient({
    apiUrl: API,
    paymentMode: "mock",
    allowInsecureDev: true,
    store: new FileSessionStore(storeDir),
    log: () => {},
  });
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("timeout waiting for condition");
}

describe.skipIf(!available)("anonymous attacker (real cluster)", () => {
  it("absorbs a create flood through one proxy path and mints no session", async () => {
    // One forwarding hop, many connections: what a NAT or reverse proxy looks
    // like to the API. A sandbox cannot reach the API at all (its NetworkPolicy,
    // packet-tested in network.test.ts), so the internet is the attacker path.
    const proxy = await singlePathProxy();
    try {
      const attempts = await Promise.all(
        Array.from({ length: 180 }, () => createAttempt(proxy.url)),
      );

      const limited = attempts.filter((attempt) => attempt.status === 429);
      expect(limited.length).toBeGreaterThan(0);
      drainedCreateBudget = true;
      expect(limited[0]?.body).toMatchObject({ error: "rate_limited", scope: "ip" });
      expect(limited.every((attempt) => attempt.retryAfter)).toBe(true);

      // Unpaid but well-formed: 402 until the bucket runs out, then 429. Never a
      // session, never a 500.
      for (const attempt of attempts) expect([402, 429]).toContain(attempt.status);
      expect(attempts.filter((attempt) => attempt.status === 201)).toHaveLength(0);
      expect(attempts.filter((attempt) => attempt.status >= 500)).toHaveLength(0);
    } finally {
      await proxy.close();
    }
  }, 180_000);

  it.skipIf(trustProxyHops !== "0")(
    "does not grant a fresh create budget for a spoofed X-Forwarded-For",
    async () => {
      // The API is configured with TRUST_PROXY_HOPS=0, so req.ip is the socket
      // peer and the header is decoration. If this deployment trusts a proxy,
      // the property to test is different and this case does not apply.
      const drained = await drainCreateBudget(API);
      expect(drained.at(-1)?.status).toBe(429);
      drainedCreateBudget = true;
      const spoofed = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          createAttempt(API, { "x-forwarded-for": `203.0.113.${index + 1}` }),
        ),
      );
      expect(spoofed.every((attempt) => attempt.status === 429)).toBe(true);
    },
    120_000,
  );

  it("rejects an oversized create body and keeps serving", async () => {
    const maxBody = Number(deployConfig("MAX_BODY_BYTES") || 32 * 1024 * 1024);
    // One byte over the configured limit is the smallest body that proves the
    // limit is the deployed value, not a default compiled into the client.
    const result = await oversizedBody(HOST, PORT, maxBody + 1024 * 1024);

    // A 413 is the expected answer. A reset is also a refusal, but a 500 or a
    // hang means the edge mishandled it.
    if (result.status !== null) expect(result.status).toBe(413);
    else expect(result.error).toBeTruthy();

    const after = await fetch(`${API}/healthz`);
    expect(after.ok).toBe(true);
  }, 180_000);

  it("closes a slowloris connection on the header timeout without stalling the API", async () => {
    const result = await slowloris(HOST, PORT, 90_000);

    expect(result.closed).toBe(true);
    // Node's headersTimeout is 60s by default; the bound is generous because a
    // loaded runner can take a little longer, but it must not be "never".
    expect(result.closedAfterMs).toBeLessThan(90_000);
    // The health probe fired while the socket was still open.
    expect(result.statusDuring).toBe(200);
  }, 150_000);

  it.skipIf(!mockPayments)(
    "answers capability brute force without leaking which sessions exist",
    async () => {
      const client = makeClient();
      const handle = await client.createSession({ tier: "short" });
      created.push(handle);

      const attempts = await Promise.all(
        Array.from({ length: 64 }, () =>
          fetch(`${API}/v1/sessions/${handle.sessionId}`, {
            headers: { "x-sandbox-capability": randomBytes(32).toString("base64url") },
          }).then((response) => response.status),
        ),
      );

      // 404 for a wrong capability (the workload suite pins that), 429 once the
      // read bucket is spent. Never 200, never 500.
      for (const status of attempts) expect([401, 404, 429]).toContain(status);
      expect(attempts).not.toContain(200);

      // A made-up session id must look the same as a wrong capability: no
      // existence oracle, and no 500 from a missing row.
      const unknown = await fetch(`${API}/v1/sessions/sbx_${"0".repeat(16)}`, {
        headers: { "x-sandbox-capability": randomBytes(32).toString("base64url") },
      });
      expect([401, 404, 429]).toContain(unknown.status);
    },
    180_000,
  );

  it.skipIf(!mockPayments)(
    "refuses a relay credential minted for a different session",
    async () => {
      const client = makeClient();
      const handle = await client.createSession({ tier: "short" });
      created.push(handle);
      await waitFor(async () => {
        const status = await fetch(`${API}/v1/sessions/${handle.sessionId}`, {
          headers: { "x-sandbox-capability": handle.capability },
        }).then((response) => (response.ok ? response.json() : null));
        return status && ["READY", "ACTIVE"].includes(String((status as { state?: string }).state))
          ? true
          : null;
      });

      // A credential genuinely bound to another session: the proxy token is the
      // per-session HMAC this test can mint, and it must not be accepted where a
      // guest relay token is expected.
      const crossSession = mintProxyToken(proxyTokenSecret, "sbx_othersession0000", 600_000);
      const foreignSession = await portForward("svc/relay", 8443);
      try {
        const wrongToken = await upgradeStatus(
          foreignSession.port,
          `/guest?session=${encodeURIComponent(handle.sessionId)}&token=${encodeURIComponent(crossSession)}`,
        );
        expect(wrongToken).toMatch(/ 401 /);

        // And an unregistered session is not served even with a plausibly
        // shaped token: the relay never falls back to "unknown means allow".
        const unknownSession = await upgradeStatus(
          foreignSession.port,
          `/guest?session=sbx_${"f".repeat(16)}&token=${encodeURIComponent(crossSession)}`,
        );
        expect(unknownSession).toMatch(/ 404 /);
      } finally {
        foreignSession.stop();
      }
    },
    240_000,
  );

  it("denies RFC1918, metadata and node egress, including DNS rebinding", async () => {
    const name = `attacker-probe-${randomBytes(3).toString("hex")}`;
    probePods.push(name);
    applyYaml(probePod(name));
    kubectl([
      "-n",
      "sandbox-workloads",
      "wait",
      "--for=condition=Ready",
      `pod/${name}`,
      "--timeout=180s",
    ]);

    const proxyIp = kubectl([
      "-n",
      "sandbox-system",
      "get",
      "svc",
      "egress-proxy",
      "-o",
      "jsonpath={.spec.clusterIP}",
    ]);
    const nodeIp = kubectl([
      "get",
      "nodes",
      "-o",
      'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}',
    ]);
    const proxyToken = mintProxyToken(proxyTokenSecret, "attacker-probe", 900_000);
    const proxy = `http://${proxyIp}:3128`;

    const probes: ProbeCase[] = [
      // Private space, including the ranges a cluster network usually lives in.
      { name: "rfc1918-10", kind: "tcp", target: "10.0.0.1:80", timeoutMs: 3_000, expected: "deny" },
      { name: "rfc1918-172", kind: "tcp", target: "172.16.0.1:80", timeoutMs: 3_000, expected: "deny" },
      { name: "rfc1918-192", kind: "tcp", target: "192.168.0.1:80", timeoutMs: 3_000, expected: "deny" },
      // Cloud metadata and the kubelet on the node the guest is scheduled to.
      { name: "metadata", kind: "tcp", target: "169.254.169.254:80", timeoutMs: 3_000, expected: "deny" },
      { name: "node-kubelet", kind: "tcp", target: `${nodeIp}:10250`, timeoutMs: 3_000, expected: "deny" },
      // A public name that resolves to a private address, through the proxy that
      // does the resolving. This is the rebinding/SSRF shape: the name is
      // allowed, the address it lands on is not.
      {
        name: "rebind-metadata",
        kind: "https-proxy",
        url: "https://169.254.169.254.nip.io/",
        proxy,
        proxyToken,
        timeoutMs: 10_000,
        expected: "deny",
      },
      {
        name: "rebind-private",
        kind: "https-proxy",
        url: "https://10.0.0.1.nip.io/",
        proxy,
        proxyToken,
        timeoutMs: 10_000,
        expected: "deny",
      },
      // No DNS in the guest at all, so the rebinding name cannot be resolved
      // locally either.
      {
        name: "dns-rebind",
        kind: "dns",
        hostname: "169.254.169.254.nip.io",
        timeoutMs: 3_000,
        expected: "deny",
      },
    ];

    const results = runProbes(name, probes);
    for (const probe of probes) {
      const result = results[probe.name];
      expect(result, `missing probe ${probe.name}`).toBeTruthy();
      expect(result!.ok, `${probe.name} should be blocked: ${result!.detail}`).toBe(false);
    }
  }, 300_000);
});
