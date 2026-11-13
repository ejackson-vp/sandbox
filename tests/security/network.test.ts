/**
 * Packet-level network isolation tests against the real kind cluster and the
 * real CNI (Cilium). These are not mocked: every probe is a TCP connection or
 * an HTTP request issued from inside the sandbox namespace.
 *
 * If the cluster is absent the suite is skipped with a loud warning; CI should
 * run `make security-test` after `make up`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mintProxyToken } from "../../controller/src/tokens.js";
import { applyYaml, clusterAvailable, CONTEXT, deleteQuietly, kubectl, kubectlJson, kubectlTry } from "./kubectl.js";
import { probePod, runProbes, type ProbeCase } from "./probe.js";

const available = clusterAvailable();
if (!available) {
  console.warn("\n[security] cluster not available: network isolation tests are SKIPPED\n");
}

describe.skipIf(!available)("network isolation (real cluster)", () => {
  const suffix = randomBytes(3).toString("hex");
  const podA = `netprobe-a-${suffix}`;
  const podB = `netprobe-b-${suffix}`;
  const proxySecret = Buffer.from(
    kubectl(["-n", "sandbox-system", "get", "secret", "x402-secrets", "-o", "jsonpath={.data.proxy-token-secret}"]),
    "base64",
  ).toString("utf8");
  const proxyToken = mintProxyToken(proxySecret, "test-probe-session", 600_000);
  let peerIp = "";
  let proxyIp = "";
  let relayIp = "";
  let nodeIp = "";
  let controllerIp = "";

  beforeAll(() => {
    applyYaml(probePod(podA) + "---" + probePod(podB));
    kubectl(["-n", "sandbox-workloads", "wait", "--for=condition=Ready", `pod/${podA}`, `pod/${podB}`, "--timeout=180s"]);
    peerIp = kubectl([
      "-n",
      "sandbox-workloads",
      "get",
      "pod",
      podB,
      "-o",
      "jsonpath={.status.podIP}",
    ]);
    proxyIp = kubectl(["-n", "sandbox-system", "get", "svc", "egress-proxy", "-o", "jsonpath={.spec.clusterIP}"]);
    relayIp = kubectl(["-n", "sandbox-system", "get", "svc", "relay", "-o", "jsonpath={.spec.clusterIP}"]);
    nodeIp = kubectl([
      "get",
      "nodes",
      "-o",
      'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}',
    ]);
    controllerIp = kubectl(["-n", "sandbox-system", "get", "svc", "controller", "-o", "jsonpath={.spec.clusterIP}"]);
    console.log(`[security] context=${CONTEXT} peer=${peerIp} proxy=${proxyIp} relay=${relayIp} node=${nodeIp}`);
  }, 240_000);

  afterAll(() => {
    deleteQuietly(["-n", "sandbox-workloads", "pod", podA, podB]);
  });

  it("blocks sandbox-to-sandbox, cluster API, node, metadata and direct egress; allows relay+proxy", () => {
    const probes: ProbeCase[] = [
      // One customer attacking another customer.
      { name: "peer-pod-80", kind: "tcp", target: `${peerIp}:80`, timeoutMs: 3000, expected: "deny" },
      { name: "peer-pod-8443", kind: "tcp", target: `${peerIp}:8443`, timeoutMs: 3000, expected: "deny" },
      // Kubernetes control plane (Service IP and node kubelet).
      { name: "k8s-api-service", kind: "tcp", target: "10.96.0.1:443", timeoutMs: 3000, expected: "deny" },
      { name: "node-kubelet", kind: "tcp", target: `${nodeIp}:10250`, timeoutMs: 3000, expected: "deny" },
      // Cloud metadata / link-local.
      { name: "metadata-v4", kind: "tcp", target: "169.254.169.254:80", timeoutMs: 3000, expected: "deny" },
      // Other control-plane Services are not reachable directly.
      { name: "controller-direct", kind: "tcp", target: `${controllerIp}:3001`, timeoutMs: 3000, expected: "deny" },
      // Direct internet egress is impossible (proxy-only).
      { name: "direct-https", kind: "direct-https", url: "https://example.com/", timeoutMs: 5000, expected: "deny" },
      // No DNS at all.
      { name: "dns-cluster", kind: "dns", hostname: "kubernetes.default.svc", timeoutMs: 3000, expected: "deny" },
      { name: "dns-public", kind: "dns", hostname: "example.com", timeoutMs: 3000, expected: "deny" },
      // Only these two destinations are permitted.
      { name: "relay-allowed", kind: "tcp", target: `${relayIp}:8443`, timeoutMs: 3000, expected: "allow" },
      { name: "proxy-allowed", kind: "tcp", target: `${proxyIp}:3128`, timeoutMs: 3000, expected: "allow" },
    ];
    const results = runProbes(podA, probes);
    for (const p of probes) {
      const r = results[p.name];
      expect(r, `missing probe ${p.name}`).toBeTruthy();
      if (p.expected === "deny") {
        expect(r!.ok, `${p.name} should be blocked but succeeded: ${r!.detail}`).toBe(false);
      } else {
        expect(r!.ok, `${p.name} should be allowed: ${r!.detail}`).toBe(true);
      }
    }
  }, 180_000);

  it("allows public HTTPS through the proxy and denies private destinations, metadata, IPv6 and rebinding", () => {
    const probes: ProbeCase[] = [
      {
        name: "proxy-public-https",
        kind: "https-proxy",
        url: "https://example.com/",
        proxy: `http://${proxyIp}:3128`,
        proxyToken,
        timeoutMs: 15_000,
        expected: "allow",
      },
      {
        name: "proxy-no-token",
        kind: "https-proxy",
        url: "https://example.com/",
        proxy: `http://${proxyIp}:3128`,
        proxyToken: "",
        timeoutMs: 8000,
        expected: "deny",
      },
      {
        name: "proxy-private-ip",
        kind: "https-proxy",
        url: "https://10.96.0.1/",
        proxy: `http://${proxyIp}:3128`,
        proxyToken,
        timeoutMs: 8000,
        expected: "deny",
      },
      {
        name: "proxy-metadata-ip",
        kind: "https-proxy",
        url: "https://169.254.169.254/",
        proxy: `http://${proxyIp}:3128`,
        proxyToken,
        timeoutMs: 8000,
        expected: "deny",
      },
      {
        name: "proxy-loopback-v6",
        kind: "https-proxy",
        url: "https://[::1]/",
        proxy: `http://${proxyIp}:3128`,
        proxyToken,
        timeoutMs: 8000,
        expected: "deny",
      },
      {
        name: "proxy-mapped-v4",
        kind: "https-proxy",
        url: "https://[::ffff:127.0.0.1]/",
        proxy: `http://${proxyIp}:3128`,
        proxyToken,
        timeoutMs: 8000,
        expected: "deny",
      },
      {
        // Public DNS name that resolves to 127.0.0.1: classic rebinding/SSRF trick.
        name: "proxy-rebinding",
        kind: "https-proxy",
        url: "https://127.0.0.1.nip.io/",
        proxy: `http://${proxyIp}:3128`,
        proxyToken,
        timeoutMs: 10_000,
        expected: "deny",
      },
      {
        name: "proxy-single-label",
        kind: "https-proxy",
        url: "https://localhost/",
        proxy: `http://${proxyIp}:3128`,
        proxyToken,
        timeoutMs: 8000,
        expected: "deny",
      },
      {
        name: "proxy-cluster-service",
        kind: "https-proxy",
        url: "https://relay.sandbox-system.svc.cluster.local:8443/healthz",
        proxy: `http://${proxyIp}:3128`,
        proxyToken,
        timeoutMs: 8000,
        expected: "deny",
      },
    ];
    const results = runProbes(podA, probes);
    for (const p of probes) {
      const r = results[p.name];
      expect(r, `missing probe ${p.name}`).toBeTruthy();
      if (p.expected === "deny") {
        expect(r!.ok, `${p.name} should be blocked but succeeded: ${r!.detail}`).toBe(false);
      } else {
        expect(r!.ok, `${p.name} should succeed: ${r!.detail}`).toBe(true);
        expect(r!.detail).toMatch(/http status \d+/);
      }
    }
  }, 180_000);

  it("denies inbound connections to sandbox pods", () => {
    // A listener in the sandbox must not be reachable from another pod or from
    // a control-plane pod. We assert the NetworkPolicy has no ingress rules and
    // verify from a second sandbox (the strongest attacker position).
    const policies = kubectlJson<{ items: Array<{ metadata: { name: string }; spec: { policyTypes: string[]; ingress?: unknown[] } }> }>([
      "-n",
      "sandbox-workloads",
      "get",
      "networkpolicy",
    ]);
    const deny = policies.items.find((p) => p.metadata.name === "default-deny-all");
    expect(deny).toBeTruthy();
    expect(deny!.spec.policyTypes).toContain("Ingress");
    expect(deny!.spec.ingress ?? []).toHaveLength(0);

    // No allow-ingress policy may exist in the namespace.
    for (const p of policies.items) {
      if (p.metadata.name === "default-deny-all") continue;
      expect(p.spec.ingress ?? [], `${p.metadata.name} must not allow ingress`).toHaveLength(0);
    }

    // Packet-level: an inbound connect from the peer namespace is blocked.
    const res = runProbes(podA, [
      { name: "inbound-self", kind: "tcp", target: `${peerIp}:9000`, timeoutMs: 3000, expected: "deny" },
    ]);
    expect(res["inbound-self"]!.ok).toBe(false);
  }, 60_000);

  it("keeps the sandbox free of Kubernetes credentials and host mounts", () => {
    // kubelet always injects KUBERNETES_SERVICE_HOST/PORT (address hints, not
    // credentials); the API path is blocked at the packet level (tested above).
    // What must be absent is the service account token and any host mount.
    const token = kubectlTry([
      "-n",
      "sandbox-workloads",
      "exec",
      podA,
      "--",
      "cat",
      "/var/run/secrets/kubernetes.io/serviceaccount/token",
    ]);
    expect(token.ok).toBe(false);

    // No writable host paths are mounted.
    const mounts = kubectl(["-n", "sandbox-workloads", "exec", podA, "--", "sh", "-c", "cat /proc/mounts"]);
    expect(mounts).not.toMatch(/hostpath|\/var\/lib\/kubelet|\/var\/run\/docker/);
  }, 60_000);
});
