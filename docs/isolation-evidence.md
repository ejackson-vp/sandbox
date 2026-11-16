# Kata isolation evidence

What the release gate's `Kata guest-to-host isolation` row has been waiting for: the
packet-level suite and the lifecycle suite, run against a real two-node Talos
cluster with Cilium and the `x402-sandbox` RuntimeClass handled by `kata`, with
the image digests the cluster actually ran.

## Runs

| Control | Guest | Result |
| --- | --- | --- |
| `0.1.33` `sha256:4804da2e…` | `0.1.33` `sha256:933a53e0…` | **23 passed, 1 skipped**, run against the deployed pair after `v0.1.33` promoted. Same four suites as the row below, same cluster, same skip: the `X-Forwarded-For` case, because this deployment sets `TRUST_PROXY_HOPS=1`. This is the first release where control and guest carry the jittered reconnect and the expiry-bounded capacity reservation. |
| `0.1.32` `sha256:540af95a…` | `0.1.31` `sha256:eea680fa…` | **23 passed, 1 skipped** (the `X-Forwarded-For` case, skipped because this deployment sets `TRUST_PROXY_HOPS=1`). The attacker suite passes here, including the per-client connection cap that `0.1.30` did not have. |
| `0.1.30` `sha256:39c8d2d0…` | `0.1.29` `sha256:bd5161d7…` | 20 passed, 1 failed, 3 skipped. The failure was version skew: `0.1.30` had no connection limiter, and `main` refused with `429 connection_limit` where the deployed build returned retryable 503s. |

The detailed record below is the first run; the second repeated the same four
suites against the promoted pair on the same cluster and produced the numbers in
the table. The boundary properties are the same in both, and the digest line in
each section names the pair it describes.

**Takeaway:** the Kata boundary is verified for the properties this suite tests
(separate guest kernel, no Service VIP, no API, node, metadata or peer reachability,
proxy-only egress, no credentials and no host mounts in the guest), at control
`sha256:39c8d2d0…` and guest `sha256:bd5161d7…`; it is not a hardware root of
trust, no escape was attempted, and the gate itself remains red on one
anonymous-attacker case that is version skew, not an isolation failure.

## 1. What ran

| Item | Value |
| --- | --- |
| Cluster | `tailscale-operator.taila53c50.ts.net` |
| Nodes | `talos-h6a-bi6` (10.0.0.214, worker), `talos-hcv-rym` (10.0.0.33, control-plane) |
| Kubernetes / runtime | v1.37.0, Talos v1.14.1, containerd 2.3.5, host kernel `6.18.51-talos` |
| CNI | Cilium on both nodes |
| RuntimeClass | `x402-sandbox`, handler `kata`, annotation `x402.io/isolation=microvm` |
| Control image | `ghcr.io/ejackson-vp/sandbox-control:0.1.30`, `sha256:39c8d2d07002c31800ef2970113d141b805ec30c7cf2380ea5c3d084d5bfcb8a` |
| Guest image | `ghcr.io/ejackson-vp/sandbox-guest:0.1.29`, `sha256:bd5161d70d2147572bbb10e2d9b4e25acdc3e3648592ed5ff6a4b074d2860120` |
| `python` profile | `ghcr.io/ejackson-vp/sandbox-guest`, `sha256:a24be7d5b158803bc0a42233e382b9b89e0fcbed33aac6bb1e2916353251a265` |
| `node` profile | `ghcr.io/ejackson-vp/sandbox-guest`, `sha256:09f93761e229a635cbce88ff12d80f1ca973b28d63c9420a1605b3c054cf63eb` |
| Guest kernel in the probe | `6.18.35` (build `#1 SMP Mon Jun 15 12:55:58 UTC 2026`) |
| Deployment config | `EXECUTION_MODE=kata`, `RELAY_GUEST_ADDRESS=pod`, `TRUST_PROXY_HOPS=1`, `WARM_POOL_SIZE=20`, `PAYMENT_MODE=mock` |

The two kernels differ (`6.18.35` in the guest, `6.18.51-talos` on the host). That
is the direct observation that the workload is not sharing the host kernel: the
probe pod ran with `spec.runtimeClassName=x402-sandbox` on `talos-h6a-bi6` and
reported a kernel the node does not run.

### Commands

Network and workload, the two files the gate requires:

```bash
export DATABASE_URL=postgres://postgres:pg@127.0.0.1:55432/sbx_kata
GUEST_IMAGE=ghcr.io/ejackson-vp/sandbox-guest@sha256:bd5161d70d2147572bbb10e2d9b4e25acdc3e3648592ed5ff6a4b074d2860120 \
GUEST_BINARY=$PWD/guest/bin/x402-guest \
API_URL=https://sandbox-api.taila53c50.ts.net \
KUBECTL_CONTEXT=tailscale-operator.taila53c50.ts.net \
npx vitest run --config vitest.security.config.ts \
  tests/security/network.test.ts tests/security/workload.test.ts
```

Result: 14 of 14 executed, 0 skipped, 0 failed.

The whole gate, with the API forwarded to the test process. `attacker.test.ts`
speaks plain HTTP on purpose (`slowloris`, an oversized body), so it needs a local
port, not the HTTPS tailnet name:

```bash
kubectl --context tailscale-operator.taila53c50.ts.net \
  -n sandbox-system port-forward svc/api 18082:3000
export GUEST_IMAGE=ghcr.io/ejackson-vp/sandbox-guest@sha256:bd5161d7…
export KUBECTL_CONTEXT=tailscale-operator.taila53c50.ts.net
export API_URL=http://127.0.0.1:18082
export ARTIFACTS=$HOME/.local/share/opencode/kata-evidence-artifacts-20261115-172031
make security-isolation
```

`GUEST_IMAGE` is required on any cluster that pulls a released image. Without it
the probe pod asks for `docker.io/x402-sandbox/guest:dev`, which does not exist:
the first attempt on this cluster produced four skipped tests and
`ErrImagePull` / `ImagePullBackOff` on both probe pods. That run proved nothing
and is recorded here only so the same mistake is not read as a pass.

## 2. Results

### `tests/security/network.test.ts`: 4 of 4 passed

| Test | Outcome |
| --- | --- |
| blocks sandbox-to-sandbox, cluster API, node, metadata and direct egress; allows relay+proxy | PASS |
| allows public HTTPS through the proxy and denies private destinations, metadata, IPv6 and rebinding | PASS |
| denies inbound connections to sandbox pods | PASS |
| keeps the sandbox free of Kubernetes credentials and host mounts | PASS |

Every probe below ran from inside a guest container (`x402-sandbox`, no
credentials, `dnsPolicy: None`) unless noted. "deny" means the connect timed out
or was refused by policy; "allow" means the TCP handshake or HTTP response
completed.

| Probe | Target | Expected | Observed |
| --- | --- | --- | --- |
| `peer-pod-80` | peer sandbox `:80` | deny | timeout, 3000 ms |
| `peer-pod-8443` | peer sandbox `:8443` | deny | timeout, 3000 ms |
| `peer-pod-listener-9000` | peer sandbox `:9000`, HTTP server running | deny | timeout, 3001 ms |
| `k8s-api-service` | `10.96.0.1:443` | deny | timeout |
| `node-kubelet` | `10.0.0.214:10250` | deny | timeout |
| `metadata-v4` | `169.254.169.254:80` | deny | timeout |
| `controller-direct` | controller ClusterIP `:3001` | deny | timeout |
| `direct-https` | `https://example.com/` | deny | DNS refused (no resolver in guest) |
| `dns-cluster` | `kubernetes.default.svc` | deny | `connection refused` on `127.0.0.1:53` |
| `dns-public` | `example.com` | deny | `connection refused` on `127.0.0.1:53` |
| `relay-allowed` | relay endpoint Pod IP `:8443` | allow | connected |
| `proxy-allowed` | egress-proxy endpoint Pod IP `:3128` | allow | connected |
| `proxy-public-https` | `https://example.com/` via proxy, valid token | allow | HTTP 200, 285 ms |
| `proxy-no-token` | `https://example.com/` via proxy, no token | deny | `proxy_authentication_required` |
| `proxy-private-ip` | `https://10.96.0.1/` via proxy | deny | `blocked_destination:cluster` |
| `proxy-metadata-ip` | `https://169.254.169.254/` via proxy | deny | `blocked_destination:cluster` |
| `proxy-loopback-v6` | `https://[::1]/` via proxy | deny | `blocked_destination:loopback` |
| `proxy-mapped-v4` | `https://[::ffff:127.0.0.1]/` via proxy | deny | `blocked_destination:loopback` |
| `proxy-rebinding` | `https://127.0.0.1.nip.io/` via proxy | deny | `blocked_destination:loopback`, 222 ms |
| `proxy-single-label` | `https://localhost/` via proxy | deny | `single_label_hostname` |
| `proxy-cluster-service` | `https://relay.sandbox-system.svc…:8443/` via proxy | deny | `port_not_allowed` |

The peer for the `peer-pod-*` cases was a second sandbox with
`python3 -m http.server 9000` running in it, and that pod answered `200` on its
own loopback, so the timeouts are policy drops rather than connects to an empty
port. The service-account token was unreadable
(`/var/run/secrets/kubernetes.io/serviceaccount/token` does not exist) and
`/proc/mounts` matched no `hostPath`, `/var/lib/kubelet` or `/var/run/docker`
entry.

### `tests/security/workload.test.ts`: 10 of 10 passed

| Test | Outcome |
| --- | --- |
| runs with a hardened pod spec, correct limits, and removes the pod | PASS |
| enforces a per-command timeout inside the cluster | PASS |
| never writes plaintext commands or output to control-plane or pod logs | PASS |
| recovers from a controller crash without orphaning the session | PASS |
| clears an interrupted operation slot after a controller restart | PASS |
| removes the workspace when a session is destroyed | PASS |
| rejects a replayed payment against the live cluster | PASS |
| Pod Security Admission rejects privileged workloads in the sandbox namespace | PASS |
| keeps a Pod terminating under a finalizer until the finalizer is removed | PASS |
| rejects operations without the session capability | PASS |

The pod-spec case read the live Pod and asserted `runtimeClassName: x402-sandbox`,
`privileged: false`, `allowPrivilegeEscalation: false`,
`readOnlyRootFilesystem: true`, `capabilities.drop: ["ALL"]`, no host namespaces,
no host volumes, no `GUEST_TOKEN` / `DEV_ATTESTATION_KEY` / `PROXY_TOKEN` in the
container environment, and the image pinned to
`ghcr.io/ejackson-vp/sandbox-guest@sha256:bd5161d7…`.

### `tests/security/warm-pool.test.ts`: 3 of 3 passed

| Test | Outcome |
| --- | --- |
| keeps session identity out of the warm pod | PASS |
| does not let a sandbox use the relay claim endpoint | PASS (guest listener answers 404) |
| gives each session fresh evidence bound to its own id | PASS |

### `tests/security/attacker.test.ts`: 5 passed, 1 failed, 1 skipped

| Test | Outcome |
| --- | --- |
| absorbs a create flood through one proxy path and mints no session | **FAIL**, 503 among 180 unpaid creates |
| does not grant a fresh create budget for a spoofed X-Forwarded-For | SKIPPED, deployment sets `TRUST_PROXY_HOPS=1` |
| rejects an oversized create body and keeps serving | PASS (413, health still 200) |
| closes a slowloris connection on the header timeout without stalling the API | PASS (closed inside 90 s, liveness 200 while held) |
| answers capability brute force without leaking which sessions exist | PASS (never 200, no 5xx) |
| refuses a relay credential minted for a different session | PASS (401 for the wrong session, 404 for an unregistered one) |
| denies RFC1918, metadata and node egress, including DNS rebinding | PASS (all 8 probes denied) |

## 3. The failures, and what they were

Three cases failed or would have failed for reasons that are not the guest
boundary. Two were defects in the suite's assumptions about addressing; one is a
behaviour the deployed build does not have.

### 3.1 Relay and proxy allow cases used a ClusterIP

First run: `relay-allowed` and `proxy-public-https` failed with `i/o timeout`. The
suite was dialling the `relay` and `egress-proxy` ClusterIPs. A Service VIP is
not reachable from inside a Kata microVM, which `docs/networking.md` documents and
this cluster reproduces exactly. Same namespace, same NetworkPolicies, same
image, the only difference is the runtime:

```text
cmp-runc (kernel 6.18.51-talos):
  relay-clusterip     true  tcp connect succeeded
  proxy-clusterip     true  tcp connect succeeded
  relay-pod-ip        true  tcp connect succeeded
  proxy-pod-ip        true  tcp connect succeeded
  k8s-api-clusterip   false dial tcp 10.96.0.1:443: i/o timeout
cmp-kata (kernel 6.18.35):
  relay-clusterip     false dial tcp 10.110.33.90:8443: i/o timeout
  proxy-clusterip     false dial tcp 10.103.12.246:3128: i/o timeout
  relay-pod-ip        true  tcp connect succeeded
  proxy-pod-ip        true  tcp connect succeeded
  k8s-api-clusterip   false dial tcp 10.96.0.1:443: i/o timeout
```

So the failure was the suite probing the `runc` data path on a Kata deployment,
not a policy regression: the guest cannot reach a VIP with any policy, and the
deployment gives it an endpoint Pod IP instead (`RELAY_GUEST_ADDRESS=pod`, and
the controller's `getServiceAddress` for the proxy). The suite now resolves the
same address the controller hands the guest. The deny cases are unchanged, and
the ClusterIP gap is still covered by the `k8s-api-service` and
`controller-direct` probes.

### 3.2 Warm-pool claim endpoint used a ClusterIP

Same cause. The test dialled the `relay` ClusterIP and got curl `000` (no
connection) instead of the `404` it asserts. It now dials the relay endpoint; the
guest listener answers `404`, which is the property under test (no control surface
on the guest port).

### 3.3 The create flood hits a 503 the deployed build cannot avoid

After the forwarder fixes, the flood reaches the API and fails on its "never a
5xx" assertion. Reproduced outside vitest, 180 concurrent unpaid creates against
the deployed API:

| Trial | 402 | 429 | 503 |
| --- | --- | --- | --- |
| 1 | 127 | 50 | 3 |
| 2 | 104 | 42 | 34 |
| 3 | 136 | 43 | 1 |
| control (after the burst settled) | 137 | 43 | 0 |

The 503 bodies are `{"error":"challenge_unavailable"}` and
`{"error":"admission_unavailable"}`, both `retryable: true` with `Retry-After: 2`.
They are 3 s client deadlines inside the API: under 180 in-flight unpaid creates,
the controller calls that mint a challenge nonce and reserve admission exceed
their timeout. The rest of the case held in every trial: 429 with
`{"error":"rate_limited","scope":"ip"}` and a `Retry-After`, no 201, no session.

This is version skew. `main` added a concurrent-request cap after 0.1.30 and the
deployed build does not have it:

- `git ls-tree v0.1.30 api/src/` has no `connection-limit.ts`; `git show
  v0.1.30:api/src/server.ts` has no limiter. `HEAD` mounts
  `createConnectionLimiter` before the body parser with defaults
  `MAX_CONNECTIONS_PER_CLIENT=64` and `MAX_CONNECTIONS_GLOBAL=2048`, and refuses
  with `429 {"error":"connection_limit"}` rather than queueing the request into
  the 3 s deadline.
- The running API's `/metrics` on `127.0.0.1:9100` has no
  `sandbox_connection_limit_total` series, so the build in the cluster has no
  such counter and no such middleware.

I did not run `main` against this cluster, so I have not observed this case pass
on `main`. What is proven is where the 5xx comes from: a retryable timeout on the
unpaid create path, with no session, no payment and no guest involvement. It is
not an isolation failure.

One more skew note for this row: 0.1.30 also predates the controller's refusal to
start when `EXECUTION_MODE=kata` and the RuntimeClass handler is not a microVM.
That guard is on `main` only. The boundary this document records depends on the
RuntimeClass staying `kata`, which is what the digests and handler above pin for
this run.

## 4. What was and was not proven

Proven on this deployment, at these digests:

- The workload ran in a Kata microVM with its own kernel (`6.18.35`) on a host
  running `6.18.51-talos`.
- A guest could not reach another guest, the Kubernetes API Service, the node
  kubelet, the metadata endpoint, the controller, any Service VIP, DNS, or the
  internet directly.
- The only reachable destinations were the relay endpoint and the egress proxy
  endpoint, and the proxy refused private, metadata, loopback, mapped-IPv6,
  single-label and rebinding destinations while allowing public HTTPS with a
  valid per-session token.
- The guest held no service-account token and no host mount.
- Lifecycle, log hygiene, payment replay, capability checks, PSA and pod
  hardening behaved as the suite asserts.

Not proven, and not claimed:

- No hardware root of trust. The RuntimeClass annotation says so, the relay
  records `evidenceType: kata-dev-no-hw-attestation`, and the deployment runs
  `ALLOW_INSECURE_DEV=true`.
- No escape was attempted. "Guest-to-host isolation" here means the boundary is
  configured, a distinct guest kernel is running, and the observable
  cross-boundary surfaces are denied. It is not a claim that the hypervisor
  resists a determined attacker.
- The `X-Forwarded-For` case was skipped because this deployment sets
  `TRUST_PROXY_HOPS=1`; the spoofing property is untested here. A skipped case is
  not evidence, and it is not counted as one.
- Connection caps and egress byte budgets are not exercised by this suite
  revision. The byte budget has unit coverage only (`tests/unit/egress-budget.test.ts`,
  `tests/unit/egress-proxy.test.ts`), and the connection cap is absent from
  0.1.30.

## 5. Gate result and artifacts

`make security-isolation` **failed with 1 problem**: `attacker.test.ts` exits 1 on
the create-flood case. Everything else in the run passed:

```text
tests/security/attacker.test.ts: 7 tests, 1 skipped, 1 failed
tests/security/network.test.ts:  4 tests, 0 skipped, 0 failed
tests/security/warm-pool.test.ts: 3 tests, 0 skipped, 0 failed
tests/security/workload.test.ts: 10 tests, 0 skipped, 0 failed
```

The script's own JUnit check requires `network.test.ts` and `workload.test.ts` to
have executed with no skips and no failures, and both did. It fails the gate on
the vitest exit status, which is correct: a security suite with a red case should
not produce a green gate. This document is the evidence; the gate row is the
integrator's call.

Artifacts from the run (`kata-evidence-artifacts-20261115-172031`):

| File | Contents |
| --- | --- |
| `junit.xml` | per-file counts above |
| `vitest.log` | full reporter output, probe addresses, failure text |
| `tested-images.json` | context, RuntimeClass handler, expected and **observed** digests and imageIDs |
| `probe-describe.txt`, `probe-logs.txt`, `probe-apply.log` | the Kata boot probe: pod reached `Succeeded` under `x402-sandbox` |
| `environment.txt` | nodes, kernels, RuntimeClass YAML, deployment images, guest config, NetworkPolicies, Cilium pods |
| `probe-matrix.json` | every probe, address, expectation and raw outcome behind section 2 |
| `clusterip-comparison.txt` | the `runc` vs `kata` Service VIP comparison in 3.1 |

## 6. Changes to the suite in this branch

The tests, not the deployment, needed fixing to run against a released, remote,
Kata cluster. None of these weakens an assertion; each replaces a kind-only
assumption with the value the deployment actually uses.

| File | Change | Why |
| --- | --- | --- |
| `scripts/isolation-gate.sh` | run `--config vitest.security.config.ts` | The root config's global setup refuses to start without Postgres and its per-test timeout is 60 s; the security config has no database and 300 s, which is what `make security-network` already used |
| `scripts/isolation-gate.sh` | record observed digests, imageIDs and the handler from the cluster | The artifact recorded intended digests; the gate is about what ran |
| `tests/security/probe.ts` | probe image from `PROBE_IMAGE` or `GUEST_IMAGE` | The kind tag `x402-sandbox/guest:dev` cannot be pulled by a cluster running a released digest |
| `tests/security/kubectl.ts` | `deployConfig` moved here; `serviceEndpoint` added | Config reads and endpoint resolution are needed by more than one file |
| `tests/security/network.test.ts` | relay and proxy probes use the endpoint the controller gives the guest | See 3.1 |
| `tests/security/warm-pool.test.ts` | claim-endpoint probe uses the relay endpoint | See 3.2 |
| `tests/security/attacker.test.ts`, `attacker-helpers.ts` | proxy egress matrix uses the proxy endpoint; `singlePathProxy` returns the API | The VIP is unreachable from the guest; a second local listener on macOS resets a 180-connection burst at `kern.ipc.somaxconn=128` before the API is involved (measured 128/180 accepted, 52 reset) |
| `tests/security/workload.test.ts` | image assertion compares to the deployment's pinned `GUEST_IMAGE@GUEST_IMAGE_DIGEST` | The old regex asserted the kind repository name, so a released `ghcr.io/…/sandbox-guest@sha256:…` failed a correct deployment |
