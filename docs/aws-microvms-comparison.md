# AWS Lambda MicroVMs vs x402

Status: learning note, November 2026. AWS behavior is taken from the public
Lambda MicroVMs developer guide and the Firecracker NSDI '20 paper. x402
behavior is what this repository actually implements and measures locally.

## Why this comparison exists

Lambda MicroVMs are the closest public product to what x402 is trying to be:
per-session Firecracker isolation, snapshot-based launch, suspend/resume with
state, idle policy, a dedicated endpoint, and strong isolation from other
tenants. It is worth copying the *lifecycle semantics* and rejecting the parts
that would make x402 a worse product.

It is not a wire-compatible target. AWS uses IAM, JWE, managed network
connectors and a managed endpoint. x402 uses x402 payments, capability tokens,
sealed envelopes and a relay. The nouns can align; the contracts should not.

## AWS model in one page

| Concept | AWS Lambda MicroVMs |
|---|---|
| Image | A Dockerfile + artifacts built into a Firecracker **memory + disk snapshot**. Versions are immutable; one image launches many MicroVMs. |
| Launch | `run-microvm` restores the snapshot. States: `PENDING → RUNNING`. No cold application boot. |
| Runtime | One dedicated MicroVM per tenant/user/job, up to **8 hours** (`maximumDurationInSeconds` ≤ 28,800). |
| Suspend | Idle policy or `suspend-microvm`. `/suspend` hook runs, then memory + disk + FDs are checkpointed. |
| Resume | `resume-microvm` or auto-resume on traffic. `/resume` hook runs before traffic is delivered. |
| Terminate | `terminate-microvm`, idle `suspendedDurationSeconds`, or max duration. `/terminate` hook runs once. |
| Hooks | `/run`, `/resume`, `/suspend`, `/terminate`; build-time `/ready`, `/validate`. |
| Endpoint | Per-MicroVM HTTPS endpoint with a port-scoped JWE token. HTTP/1.1, HTTP/2, WebSocket, gRPC, SSE. |
| Network | Ingress connectors; egress connectors (internet or VPC). `NO_INGRESS` disables inbound. |
| Capacity | Account-level memory quota, with vertical burst to 4× baseline. Bandwidth scales with memory. |
| Pricing | Per-second running compute, snapshot write/read/storage, no compute charge while suspended. |

Key AWS design choices worth internalizing:

- **Snapshot is the fast path.** The image build pays application startup once;
  every launch after that restores a fully initialized process.
- **Snapshots are shared baselines.** Unique IDs, secrets, entropy, connections
  and file descriptors captured at build time are shared by every MicroVM from
  that image version. AWS explicitly tells you to regenerate them in `/run`.
- **Hooks are the compatibility boundary.** `/run` resets uniqueness, `/resume`
  re-establishes connections, `/suspend` flushes, `/terminate` cleans up.
- **Endpoint auth is port-scoped.** A token is bound to one MicroVM, a set of
  ports, and a short expiry. There is no unauthenticated endpoint.
- **Isolation is per session, not per request.** Each MicroVM is its own
  Firecracker VM; there is no warm-VM reuse across tenants.

## Side-by-side

| Dimension | AWS Lambda MicroVMs | x402 today | Reading |
|---|---|---|---|
| Isolation | Firecracker + KVM, per MicroVM | Kubernetes pod; no `/dev/kvm` on the local rig | AWS wins until x402 runs on KVM |
| Fast start | Snapshot restore, sub-second | 1.80 s cold pod; 100.7 ms warm-pool claim | Different mechanisms; not directly comparable |
| Warm capacity | No warm pool. Launch restores a snapshot | Fixed-size pool of pre-booted pods; claim-once | x402's pool is a local stand-in for snapshot restore |
| State across suspend | Memory + disk + FDs | Disk only (PVC); fresh guest process | AWS is strictly stronger |
| Idle policy | `maxIdleDurationSeconds`, `suspendedDurationSeconds`, `autoResumeEnabled` | `maxIdleSeconds`, `suspendedDurationSeconds`, `autoResume` (advisory) | x402 matches the shape; auto-resume is client-driven |
| Max lifetime | 8 h, includes suspended time | `maxLifetimeSeconds` ≤ 8 h, includes suspended time | Match |
| Run payload | `runHookPayload` (16 KB) | Claim frame with session config | Match in spirit |
| Data plane | Direct HTTP/2/WS/gRPC/SSE endpoint | Relay-mediated exec/files/services/HTTP/SSE/WS | AWS is broader; x402 is more private |
| Ingress | Managed HTTPS endpoint + JWE | No inbound pod networking; relay only | x402 is stricter, but adds relay complexity |
| Egress | Internet or VPC connector | Egress proxy with allowlist | x402 is finer-grained; AWS is more operationally complete |
| Tenant auth | IAM for control, JWE for data | Payment capability + sealed envelopes | Different products; x402 is payment-native |
| Secrets | App sees plaintext inside its VM; AWS manages endpoint TLS | Control plane never sees customer plaintext | x402 wins on control-plane secrecy |
| Capacity control | Account memory quota, 4× burst | Admission per IP/payer; baseline/peak requests; no cluster quota | AWS wins on capacity admission |
| Ops | Managed DaemonSet-equivalent, quotas, metrics, no cluster to run | Single controller, kind, manual cluster tests | AWS wins; x402 is a prototype |
| Snapshot storage | First-class, billed | No memory snapshot; PVC storage only | AWS wins |

## What x402 already matches

1. **Lifecycle vocabulary.** `run`, `suspend`, `resume`, `terminate`,
   `idlePolicy`, `maxLifetimeSeconds` already line up with AWS. The state
   machine is x402-native (`PAID`, `PROVISIONING`, `READY`, `ACTIVE`,
   `SUSPENDED`, `TERMINATING`), but the transitions are the same shape.
2. **Idle policy semantics.** x402's `maxIdleSeconds`,
   `suspendedDurationSeconds` and `autoResume` were deliberately modeled on
   Lambda MicroVMs.
3. **8-hour wall clock.** Suspended time counts toward
   `maxLifetimeSeconds`, matching AWS's `maximumDurationInSeconds`.
4. **Per-session state.** A suspendable session gets its own PVC and a fresh
   guest keypair on resume. There is no session reuse.
5. **Baseline + burst.** x402's scheduler requests use a baseline and limits
   remain the burst ceiling, which is the same resource story as AWS's
   baseline + 4× burst, even though the enforcement is Kubernetes requests.
6. **Warm handoff without customer identity.** The warm pool pod template has
   no session id, client key or nonce. Those arrive only in the claim, after
   payment.

## What x402 deliberately does differently — and can beat AWS on

- **Payment-native admission.** AWS sells compute through IAM/account billing.
  x402 admits a session only after an x402 payment settles, with replay-safe
  payment intents. That is the product.
- **Control-plane secrecy.** AWS terminates TLS at the managed endpoint, so the
  application sees plaintext. x402's API/controller/relay only handle sealed
  envelopes; commands, files and results are decrypted by the guest and client.
  This is a real differentiator for a sandbox that executes customer code.
- **Per-session egress policy.** AWS exposes coarse connectors (internet or
  VPC). x402 can enforce a per-session allowlist through the egress proxy and
  keep the proxy token out of the guest environment.
- **Operation-level metering.** x402 can bill or quota per exec/file/stream,
  not just per running second. AWS prices compute and snapshots.
- **No vendor lock-in.** The same control plane can target Firecracker, Kata,
  or a confidential runtime class. AWS is one implementation.
- **Relay-only ingress.** x402 has no inbound pod network at all. AWS's managed
  endpoint is convenient, but it is still an ingress path with a token; x402's
  default is stronger isolation at the cost of a relay hop.

## What x402 should borrow

### 1. Make snapshot restore the fast path, not the warm pool

The warm pool exists because container startup is 1.32 s of a 2.1 s local cold
start. On a real KVM host, a Firecracker snapshot restore is the correct
mechanism: per-session isolation, no reuse, no pool state to reconcile. The
warm pool should be treated as a **development-only stand-in** until that
lands.

Concrete policy:

- Keep `WARM_POOL_SIZE=0` as the default.
- Do not add warm-VM reuse, autoscaling, or cross-session reset logic.
- Keep claim-once and per-session PVCs.
- When Firecracker snapshot/restore lands, delete the warm pool rather than
  extending it.

### 2. Add explicit `SUSPENDING` and `RESUMING` states

**Implemented.** AWS exposes `SUSPENDING` and treats resume as a distinct
transition. x402 now has both states in the pure transition table, the SQL
guards and the reconciler. `SUSPENDING` is repaired idempotently after a
controller crash; `RESUMING` uses the resume start time for its provisioning
timeout instead of the original `paidAt`. This also fixed a latent bug where a
session suspended for longer than `PROVISIONING_TIMEOUT_MS` could be failed
immediately on resume.

### 3. Standardize lifecycle hooks

AWS's `/run`, `/resume`, `/suspend`, `/terminate` hooks are a clean seam. x402
has the behavior but not a named hook contract. A small guest hook interface
would let us:

- reset per-session uniqueness on every run/resume (already done for keys),
- flush workspace state before suspend,
- re-establish egress connections on resume,
- run termination cleanup once.

Do not copy the AWS HTTP hook wire format; make it an internal guest contract
and keep the relay envelope.

### 4. Port-scoped capabilities for services

AWS tokens are bound to a MicroVM, a port set, and an expiry. x402's capability
is session-scoped. If we expose more than one service, a service-scoped
capability (or a port allowlist in the capability) is a useful tightening. It
also pairs well with the existing 4-service limit.

### 5. Capacity-aware admission

AWS has an account memory quota and a 4× burst envelope. x402 has per-payer
admission and a provisioning queue, but no cluster-capacity admission. A
simple `max_reserved_memory_mib` / `max_concurrent_sessions` check in the
controller would prevent a paid burst from overcommitting a node pool.

### 6. Snapshot storage accounting

AWS bills snapshot writes, reads and storage; x402 treats suspend as free.
A production product needs to decide whether suspended storage is billed,
included, or capped. This is a pricing/model decision, not a code detail.

## What not to copy

- **JWE/IAM endpoint contract.** It is AWS-specific and would add a second auth
  system. Keep x402 capability + sealed envelopes.
- **Warm-VM reuse across invocations.** AWS does not reuse a MicroVM across
  tenants; FES does reuse warm VMs for short function calls. x402 should keep
  claim-once for session isolation, even if it costs density.
- **Shared snapshot uniqueness.** AWS's shared baseline is a footgun: unique
  entropy and connections must be reset in `/run`. x402's fresh guest process
  and fresh keypair on resume avoid this class of bug; do not regress it for a
  faster restore.
- **A privileged, host-networked daemon by default.** Firecracker needs KVM and
  host privileges, but the controller should stay unprivileged. Put host
  privileges in a separate node agent, not in the API/controller.
- **Managed endpoint as the only ingress.** Keep relay-only as the default and
  make direct ingress an explicit opt-in for latency-sensitive services.

## Isolation: what changes off local

Moving off the Mac does **not** automatically give AWS-grade isolation. It
gives us the option to get it:

- **Firecracker/Kata/CoCo needs `/dev/kvm`.** The local kind rig has no KVM, so
  the guest is a container with pod isolation, not a hardware VM.
- **The control plane is already VM-agnostic.** Sealed envelopes, capability
  auth, relay-only ingress and the egress proxy do not depend on the isolation
  mechanism.
- **A real VM boundary changes the threat model.** The guest can still be
  compromised, but it cannot read other tenants' memory or the host. That is
  the FES advantage; x402 can adopt it without changing the wire protocol.
- **Attestation becomes meaningful only with a real TEE/runtime.** Simulated
  evidence remains a dev mode. Do not claim confidential isolation locally.

## Suggested next experiments

1. **Snapshot port (implemented as a seam).** `Snapshotter` (`capture`,
   `restore`, `discard`) now has a no-op local adapter and is wired into
   suspend, resume and termination. The next step is a Firecracker/Kata
   implementation on a KVM host, not a change to the lifecycle use cases.
2. **`SUSPENDING`/`RESUMING` (implemented).** The pure state machine, SQL
   guards, reconciler recovery and property tests now cover both states.
3. **Add cluster-capacity admission.** A pure `admitCapacity(snapshot, request)`
   function, property-tested, with a controller check before provisioning.
4. **Prototype one Firecracker VM on a Linux/KVM host.** Measure boot, snapshot
   restore, exec, suspend and resume against the current 1.80 s / 100.7 ms /
   0.86–1.91 s numbers.
5. **Decide snapshot storage pricing.** Free, included up to N GB-hours, or
   metered separately.

## Bottom line

AWS Lambda MicroVMs validate the lifecycle model x402 already chose. The
remaining gap is not the API shape; it is the substrate: memory snapshots,
real KVM isolation, capacity admission and production operations. The warm
pool is the wrong place to close that gap. Freeze it, keep it dev-only, and
make snapshot restore the fast path when the hardware exists.
