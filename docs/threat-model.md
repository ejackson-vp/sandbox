# Threat model

Blunt, per-mode analysis of what is and is not mitigated. "Mitigated" means
implemented **and** covered by tests in this repository.

## 1. Assets

| Asset | Requirement |
| --- | --- |
| Commands, file names/contents, stdout/stderr | never visible to the control plane, logs, storage or operators |
| Client private key | only on the customer device |
| Session capability | unforgeable, session-scoped, time-limited |
| Payment authorization | single-use, bound to amount/recipient/network/tier |
| Guest keys / relay token | not exposed to customer code |
| Infrastructure credentials | never reachable from the sandbox |
| Workspace data | confined to one session, destroyed at termination |

## 2. Adversaries

### A. Malicious customer running arbitrary code

| Threat | Dev (runc) | Kata VM |
| --- | --- | --- |
| Escape to host | Container + seccomp + no caps + PSS restricted, but **shared kernel** → not a boundary | VM boundary |
| Read supervisor keys | `PR_SET_DUMPABLE=0` blocks ptrace/`/proc/mem`; bootstrap file deleted; env scrubbed. Root on the node can still read memory | Guest kernel isolation |
| Reach Kubernetes API / nodes / metadata / other pods | Default-deny; only relay + proxy pods allowed; packet-tested | Same |
| Direct internet | Proxy-only; direct egress blocked | Same |
| Proxy SSRF (private IPs, rebinding, IPv6, metadata) | Proxy resolves + validates every IP, pins the validated IP, denies private/metadata/ULA/link-local/cluster/mapped forms | Same |
| Exfiltrate via DNS | No usable DNS (`dnsPolicy: None`, black-hole resolver, policy deny) | Same |
| Persist data / leave processes | Ordinary: memory `emptyDir`; suspendable: per-session PVC deleted at termination; process group killed per command; no hostPath | Same |
| Fork bomb / disk exhaustion | CPU/memory limits, per-pod `pod-max-pids` cgroup cap, disk quota, per-file cap, per-command timeout, lease cap | Same |
| Archive traversal / symlink escape | Path canonicalisation, symlink-parent rejection, `O_NOFOLLOW`, tar entry validation | Same |
| Read another session's data | Separate pod, keys, relay entry, capability; no shared volumes | Same |
| Guess/replay another capability | 256-bit random-ish HMAC, SHA-256 stored, scoped by session, TTL, constant-time compare | Same |
| Replay a request id | Controller maps `(session, requestId)` to one execution and stores the client's canonical-operation SHA-256 (ciphertext hash as fallback); a same-operation retry returns the cached result, a different operation gets `409 idempotency_key_reused`. The stored result envelope is client-sealed, so replaying it reveals nothing to the controller or to storage | Same |
| Abuse the relay as a tunnel | Relay only understands `request/cancel/shutdown` + opaque response; no arbitrary forwarding | Same |

**Not mitigated:** the customer can always consume the resource they paid for,
and can run code that is malicious inside its own sandbox.

### B. Compromised guest supervisor

- Can read the plaintext of **its own** session (it must decrypt to execute).
- Cannot read other sessions: per-session key pair, per-session relay token,
  one connection per session, evidence bound to session/nonce/client key.
- Cannot reach the control plane: no RBAC, no route, no proxy credential for
  internal destinations.
- In dev mode it may influence the host (shared kernel); that is why dev is not
  for hostile code.

### C. One customer attacking another

- Distinct pods, keys, relay entries; default-deny between sandbox pods (tested
  packet-level: peer pod unreachable on any port).
- Capability hashed, session-scoped, TTL; cross-session use returns 404 (tested).
- No shared volumes, no shared SA, no host namespaces.

### D. Compromised Kubernetes API or worker node

| Threat | Result |
| --- | --- |
| Read pod specs/env | no plaintext: only ciphertext; relay token lives in a deleted 0400 file; relay URL has no token |
| Read pod logs | counts, operation names, exit codes only (marker test) |
| Exec into a sandbox | dev/Kata: gives access to guest memory — **real limitation**; TEE: hardware boundary |
| Delete pods | availability only; session fails closed, cleanup converges |
| Read controller DB | metadata + capability hashes, no plaintext |
| Read relay memory | ciphertext + sizes |
| Forge session state | cannot without the admin token and NetworkPolicy path |

### E. Malicious cloud infrastructure administrator

- Can read memory and snapshot the node. Trusted by construction: there is no
  hardware root of trust, so the design assumes the operator is honest about
  which guest it runs.
- The **control plane** is outside the plaintext TCB even in dev: it never holds
  a decryption key.

### F. Payment replay, double charge, lost entitlement

| Threat | Handling |
| --- | --- |
| Same payment used twice | facilitator nonce store + `payment_intents` PK + `payments` PK + `sessions.payment_key` UNIQUE; replay returns the same session (200) |
| Captured create request replayed later | the wallet signature covers a server-issued single-use `challengeNonce`; the controller burns it before capacity or settlement (#47) |
| Concurrent duplicates | intent `claimed` → `409 in_progress`; exactly one session (tested 6-way) |
| Settled but API crashed before entitlement | durable intent + facilitator settlement lookup completes it on retry (tested) |
| Reused settlement with a different spec | intent stores `spec_hash`; mismatch → 409, no session |
| On-chain/testnet recovery | no lookup contract → `409 reconciliation_pending`; never charges twice, never fabricates an entitlement |
| Refunds | a durable claim (`REFUND_SENDING` + token + lease) before sending, and a stable `refund:<paymentKey>` idempotency key on every retry: effectively-once, conditional on the provider deduping the key. A crash or timeout after the provider paid resends the same key; two workers cannot claim the same row |

### G. Denial of service / resource exhaustion

- Per-pod CPU/memory/ephemeral limits, PID caps, disk quota, per-command timeout,
  lease cap, provisioning timeout, API rate limits, relay session/pending/frame
  caps, proxy connection caps.
- An attacker can still buy all capacity (business model) and can burn paid time.
- Orphan reaping and `activeDeadlineSeconds` prevent indefinite workloads.

### H. SSRF / egress bypass

| Attempt | Handling |
| --- | --- |
| Direct private IP | NetworkPolicy denies all but relay/proxy |
| Hostname → 127.0.0.1 / 10.x | proxy validates every resolved address, connects to the validated IP |
| DNS rebinding | single resolution, connect by IP literal |
| `::ffff:127.0.0.1` | classified by embedded IPv4 |
| IPv6 ULA/link-local/NAT64/6to4/Teredo | denied |
| Port hopping | only 443 |
| Proxy as a general tunnel | destination-policed CONNECT, no raw forwarding |
| Another session's proxy token | HMAC bound to session id, TTL |
| Package managers | must be proxy-aware (`HTTPS_PROXY` is set for the child); direct registry access is blocked by design |

### I. Malicious workload images

Customers cannot choose an image, command, PodSpec, annotations or runtime
class. The controller builds the pod from a fixed template and one
operator-configured image. Production should pin by digest and enforce it with
admission control.

### J. Attestation replay or substitution

- Evidence binds session id, client nonce, guest key, client key, measurement and
  validity window (lease + 5 min).
- Different session → `session_mismatch`; replayed connection → relay refuses a
  second guest; stale evidence → `stale`/`expired`.
- Any claim of hardware backing is rejected (`inconsistent_evidence`); there is
  no hardware evidence path to downgrade to.

### K. Snapshot or plaintext leakage via logging/storage

- Plaintext exists only in the customer process, the supervisor memory and the
  child process.
- Logs redact envelopes, tokens, file contents, commands; a marker test asserts
  code/output never appear in any control-plane or pod log.
- The controller's database stores metadata (state, timings, hashes, limits) plus
  the **client-sealed result ciphertext** in `exec_requests.result_envelope`
  (schema v17), so a retry can be answered after the relay's 5 minute cache
  evicts the result. The controller holds no key for that column and cannot open
  it; it is written only below `MAX_PERSISTED_RESULT_BYTES` (1 MiB, larger
  results are dropped rather than truncated) and cleared for the session in the
  same transaction that finalizes it, so ciphertext is retained only for live
  and terminating sessions. The request rows stay for audit.
- The relay stores ciphertext with a 5-minute TTL.
- Ordinary workspace is memory-backed and deleted with the pod. Suspendable
  workspaces use a per-session PVC, deleted at termination; the PVC is
  **plaintext** and the node/storage administrator can read it. The control
  plane still holds no key — see [ADR 0007](adr/0007-checkpoint-at-rest-plaintext.md).
- The controller never logs bodies or headers.

### L. New session-specific races

| Race | Handling |
| --- | --- |
| Two execs at once | atomic single-operation claim → one runs, one gets `409 busy` |
| Retry after network loss | same `requestId` and canonical operation returns the cached encrypted result, even if the envelope was re-sealed; a different operation is `409 idempotency_key_reused`. Past the relay cache the stored envelope on the request row answers the retry; the controller still cannot open it. |
| Cancel vs completion | cancel is best-effort; whichever response arrives is bound to the request id; duplicates are idempotent |
| Lease expiry during a command | guest watchdog cancels; controller deletes the pod regardless |
| File write vs lease expiry | guest checks the lease before dispatch; pod deletion ends any in-flight I/O |
| Destroy during an operation | controller sends shutdown, deletes the pod; the operation fails and the session finalises |

### M. Side channels

Even with future TEEs: cache/timing side channels, access-pattern leakage,
hypervisor-coordinated DoS, attestation-policy mistakes and firmware issues
remain. Confidential computing protects data in use; it is not verifiable
computation and this system is **not** "zero knowledge".

### N. Warm pool

A warm pod is booted before it has a session, so the pool changes *when*
identity and keys enter the sandbox, not the isolation boundary.

| Threat | Handling |
| --- | --- |
| Read a previous customer's data from a pooled pod | No pod is ever returned to the pool. A claimed pod is relabelled and destroyed at session end; there is no reuse/reset path. |
| Learn a session id/key before payment | The warm pod template has no `SESSION_ID`, client key, nonce, token, or capability. The claim is the first time they enter the pod. |
| Reuse the pool's keypair/evidence | The pool hello is `evidenceType: "warm-pool"` and is only a readiness signal. The guest generates a fresh keypair and fresh evidence after the claim. |
| Claim a pod as another customer | Only the controller may call the relay's admin claim endpoint; sandbox pods cannot reach it. |
| Sniff the claim on the relay | The relay is a trusted control-plane component and already handles ciphertext; it cannot decrypt payloads. The claim carries the session guest token (not the customer capability). Future hardening: seal the claim to a guest key announced in the pool hello. |
| Controller/relay compromise during claim | Can redirect or deny a session (availability/impersonation) exactly as it can for a cold pod. The controller already holds the simulated evidence key, so it can already impersonate a guest; the pool does not widen that. |
| Pool exhausts node capacity | `WARM_POOL_SIZE` is operator-controlled and bounded (0–50), and it is a total across every runtime profile: `WarmPoolManager` never allocates more than that budget to all profiles together. Idle pods have small real usage (~3.4 MiB) but reserve scheduler requests. |

### O. Checkpoint workspaces

A suspendable session keeps its `/workspace` on a per-session PVC while the pod
is gone.

| Threat | Handling |
| --- | --- |
| Read a suspended workspace | **Yes** for the node/storage administrator. The PVC is plaintext; no component encrypts it and the controller holds no checkpoint key. `local-path` provides no encryption, and an encrypted CSI class (where available) is not verified by the controller and does not remove the node admin. See [ADR 0007](adr/0007-checkpoint-at-rest-plaintext.md). |
| Reuse another session's workspace | One PVC per session, name-bound, deleted on terminate / suspended expiry / max lifetime; never handed to another session. A labelled PVC no session owns is reaped after `ORPHAN_PVC_GRACE_MS`. |
| Resume with stale guest keys | The resumed guest generates a **new** keypair and fresh evidence; the client must re-verify before operating. The old pod/private key is gone. |
| Replay a capability after resume | The capability is payment-bound and remains valid for `maxLifetimeSeconds`; the client nonce and session id are unchanged, so operations remain bound to the same session. A leaked capability is the same risk as a live session. |
| Relay state after suspend | Purged at suspend; resume registers a new entry/token. |

### P. Local services and HTTP

A customer can start a long-running process and send HTTP to it through the
relay.

| Threat | Handling |
| --- | --- |
| Reach the node, metadata or another service | The guest ignores the host and dials `127.0.0.1:<port>`; the port must belong to a running service. No host field exists in the protocol. |
| Redirect to an external host | Redirects are not followed (`ErrUseLastResponse`); the transport has no proxy. |
| Use HTTP as a general egress tunnel | The request is loopback-only; external egress still goes through the normal proxy policy (and is denied by the pod NetworkPolicy otherwise). |
| Leak service output/body to the control plane | The command, headers, body and response travel inside the sealed envelope; the API/controller only see ciphertext. |
| Leave a server running after the lease | Services are process groups; `stop`, suspend, terminate and lease end call `shutdownAll`, which stops them. On Linux `Pdeathsig` is a backstop. |
| Cross-session access to a service | Services live inside one guest/network namespace; no other session can reach them; the relay entry is capability-bound. |
| Stream exhaustion | Max 4 streams, 64 MiB per stream, 64 KiB chunks, 60 s idle; close/shutdown cancels the request. |
| WebSocket escape/exhaustion | Loopback-only, declared port, no proxy, 4 MiB message, 64 MiB total, 60 s idle, max 4 sockets; close/shutdown closes them. |

## 3. Risk summary

| Risk | Dev | Kata |
| --- | --- | --- |
| Control plane reads commands/files/output | Mitigated | Mitigated |
| Storage/logs read plaintext | Mitigated | Mitigated |
| Host admin reads guest memory | Not mitigated | Not mitigated |
| Host admin tampers with execution | Not mitigated | Not mitigated |
| Customer↔customer isolation | Mitigated (network + process) | Mitigated (network + VM) |
| Kernel escape | Not mitigated | Mitigated (VM) |
| Payment replay / double charge | Mitigated | Mitigated |
| Fake key binding accepted | Mitigated (signature + session binding) | Mitigated |
| Filesystem escape | Mitigated | Mitigated |
| Warm-pool cross-session reuse | Mitigated (claim-once, no reset) | Mitigated |
| Suspended workspace at rest | PVC; plaintext, node admin can read it | Same; VM does not encrypt the volume |
| Local service HTTP escape | Loopback + declared port; no inbound | Same |
| Side channels | N/A (no claim) | N/A (no claim) |
