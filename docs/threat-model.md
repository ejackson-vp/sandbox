# Threat model

This document is deliberately blunt about what each mode does and does not
protect against. "Mitigated" below means *implemented and tested in this
repository*; "designed" means the interface exists but the production back end
is not implemented.

## 1. Assets

| Asset | Confidentiality requirement |
| --- | --- |
| Customer source code | Never visible to the provider's control plane, logs, storage or operators |
| Customer output / results | Same |
| Customer result-decryption key | Only on the customer device |
| Payment authorization | Single-use, bound to amount/recipient/network |
| Session capability | Unforgeable, short-lived, single-session |
| Guest→client result channel | Confidential and authenticated |
| Infrastructure credentials | Never reachable from customer code |

## 2. Adversaries and mitigations

### A. Malicious customer running arbitrary code

Capabilities: full control of the Python program, all CPU/memory of the sandbox,
the ability to open sockets, fork, and read its own environment.

| Threat | Mode A (dev pod) | Mode B (Kata VM) | Mode C (hardware TEE) |
| --- | --- | --- | --- |
| Escape to host / node | Container + seccomp + no caps + PSS restricted; **host kernel shared** → not a security boundary for hostile code | VM boundary (Kata), separate guest kernel | VM boundary + memory encryption + integrity |
| Read provider credentials | No SA token, no hostPath, no service-link env, bootstrap secrets deleted before payload arrives; same UID as guest so `/proc/1/mem` is the residual risk (mitigated by yama + short lifetime) | Same, plus guest kernel isolation | Same, plus hardware isolation |
| Reach Kubernetes API / other pods / metadata | NetworkPolicy default-deny; tested at packet level | Same | Same |
| Reach internal services | Only relay + proxy pod IPs are allowed | Same | Same |
| Exfiltrate via DNS | No DNS at all (`dnsPolicy: None`, black-hole resolver) | Same | Same |
| Reach the internet directly | Proxy-only; direct egress blocked | Same | Same |
| Abuse the proxy to reach private IPs | Proxy resolves + validates every IP, denies private/metadata/ULA/link-local/cluster, pins the IP it validated | Same | Same |
| Fork bomb / resource exhaustion | CPU/memory/ephemeral-storage limits, `pod-max-pids=1024`, 60 s deadline | Same | Same |
| Persist data | Memory-backed `emptyDir` only, pod deleted at completion, no snapshots | Same + VM discarded | Same |
| Read another customer's data | Separate pod/VM, separate keys, separate relay session, no shared volumes | Same | Same + memory encryption |

**Not mitigated in any mode:** a customer can always consume the resource they
paid for, and can always run code that is malicious *inside* its own sandbox.

### B. Compromised sandbox guest

If the guest runtime is compromised (e.g. an RCE in the Python interpreter or the
Go binary):

- It can read the plaintext of **its own** customer's code and result (it already
  can; that is its job).
- It cannot read other customers' keys: each guest has a fresh X25519 keypair and
  a per-session relay token; the relay refuses a second connection.
- It cannot reach the control plane: no RBAC, no API route, no network path.
- It cannot impersonate a guest for another session: evidence is bound to
  session id + client nonce + client key, and the customer verifies it.
- In Mode A it may be able to influence the host (shared kernel); this is why
  Mode A is explicitly not for hostile code.

### C. One customer attacking another

- Distinct pods/VMs, distinct keys and relay sessions, default-deny ingress **and**
  egress between sandbox pods (tested: pod A cannot reach pod B on any port).
- Relay enforces one live connection per session and binds frames to the session.
- Capabilities are hashed, session-scoped and time-limited; cross-session use
  returns 404 (tested).
- No shared volumes, no shared process namespace, no shared service account.

### D. Compromised Kubernetes API or worker node

| Threat | Result |
| --- | --- |
| Read pod specs/env | No plaintext: only ciphertext envelopes ever transit the API; the guest token and dev key live in a 0400 file that is deleted before execution |
| Read pod logs | Guest logs contain counts and error codes only (tested by grepping for markers) |
| Exec into a sandbox | Would give access to the guest's memory in Modes A/B. **This is a real limitation**; Mode C relies on hardware isolation + guest policy, and even then a node admin can deny service |
| Delete pods | Availability only; the controller converges and the session fails closed |
| Read the controller DB | Ciphertext metadata + capability hashes only |
| Read the relay memory | Ciphertext only |

A compromised **node in Mode A/B** can read guest memory, including plaintext
code, if it can attach to the process. Nothing in this repository prevents that;
only Mode C's hardware isolation does (and even then, side channels remain).

### E. Malicious cloud infrastructure administrator

- Mode A/B: can read memory, can snapshot the node, can drop traffic. Treated as
  trusted.
- Mode C: SEV-SNP/TDX remove the hypervisor/host from the TCB for
  confidentiality and integrity of guest memory. Remaining risks: availability,
  side channels, and mis-issued attestation policy.
- The design intentionally keeps the **control plane** outside the TCB for
  plaintext: even a fully compromised API/controller/relay never has a key that
  can decrypt customer code.

### F. Payment replay / double spend

- Facilitator nonce store is the authority: `INSERT` with UNIQUE constraint;
  concurrent duplicates lose.
- Controller: `payments.payment_key` PK and `sessions.payment_key` UNIQUE, inside
  `BEGIN IMMEDIATE`.
- Tests: sequential replay, 6-way concurrent replay, settlement failure, and a
  cluster-level replay test.
- In mock mode there is no economic security at all: anyone can generate a
  wallet and sign. Testnet mode uses the real facilitator and on-chain nonce
  semantics.

### G. Denial of service / resource exhaustion

- Per-pod CPU/memory/ephemeral-storage limits, PID cap, 60 s cap, provisioning
  timeout, per-IP token buckets on the API, relay session cap and frame size cap,
  proxy per-session connection cap and idle timeout.
- An attacker can still buy all available capacity (that is the business model)
  and can make the provider pay for failed attestations; there is no refund
  mechanism in the prototype.
- Orphan reaping and `activeDeadlineSeconds` ensure workloads cannot outlive
  their entitlement indefinitely, even if the controller crashes.

### H. SSRF / egress-policy bypass

| Bypass attempt | Handling |
| --- | --- |
| Direct socket to private IP | NetworkPolicy denies everything except relay/proxy |
| DNS name resolving to 127.0.0.1 / 10.x | Proxy validates every resolved address and connects to the validated IP |
| Rebinding between check and connect | Single resolution, connect by IP literal |
| `::ffff:127.0.0.1` | Classified by embedded IPv4 |
| IPv6 ULA / link-local / NAT64 / 6to4 / Teredo | Denied |
| Port hopping (22, 6379, 8080…) | Only 443 is allowed |
| Proxy as a general tunnel | It is a CONNECT proxy with destination policy, not a network bridge; no raw forwarding |
| Using another session's proxy token | HMAC includes the session id; token is time-limited |

Egress remains a **policy** boundary: if the proxy is compromised, the sandbox
gains the proxy's network position. The proxy is therefore kept minimal and has
no credentials.

### I. Malicious workload images

Customers cannot specify an image, command, args, or PodSpec. The controller
builds the pod from a fixed template and a single operator-configured image
(`GUEST_IMAGE`). A production deployment should pin `GUEST_IMAGE` by digest and
enforce it with an admission policy (Kyverno/sigstore) — noted in
`production-readiness.md`.

### J. Attestation replay or substitution

- Evidence is bound to `sessionId`, `clientNonce` (customer random), guest public
  key, and customer public key, and has a 120 s validity window.
- A different session's evidence fails `session_mismatch`; a replayed envelope in
  the same session is refused by the relay's single-connection rule.
- Simulated evidence is marked `insecureDevOnly` and rejected unless the caller
  opted in; `confidential` mode rejects it unconditionally.
- Hardware evidence is **never** accepted on the strength of a signature: it must
  go through the (unimplemented) hardware verifier, which currently fails closed.

### K. Snapshot or plaintext leakage via logging/storage

- Plaintext exists only in: the customer process (CLI), the guest process memory,
  and the Python child process. It is never sent to the API.
- Logs redact envelopes, tokens, code, stdout/stderr; tests assert that unique
  code/output markers never appear in any control-plane or pod log.
- SQLite stores session metadata only. The relay stores ciphertext with a TTL.
- No persistent volumes are mounted into sandbox pods; the workspace is a
  memory-backed `emptyDir`, removed with the pod.
- The controller's request logger never logs bodies or headers.

### L. Side channels and limits of confidential computing

Even with SEV-SNP/TDX: cache/timing side channels, memory-access-pattern leakage,
hypervisor-coordinated denial of service, attestation-policy mistakes and
firmware/microcode vulnerabilities remain. Confidential computing protects data
**in use** from the host; it is not a proof of correct execution, and this system
does not attempt verifiable computation. (It is **not** "zero knowledge"; see
`security-guarantees.md`.)

## 3. Risk matrix summary

| Risk | Mode A | Mode B | Mode C |
| --- | --- | --- | --- |
| Provider control plane reads code | Mitigated | Mitigated | Mitigated |
| Provider storage/logs read code | Mitigated | Mitigated | Mitigated |
| Host admin reads guest memory | **Not mitigated** | **Not mitigated** | Mitigated (hardware) |
| Host admin tampers with execution | Not mitigated | Not mitigated | Mitigated (integrity) |
| Customer↔customer isolation | Mitigated (network + process) | Mitigated (network + VM) | Mitigated (network + VM + memory) |
| Escape via kernel exploit | Not mitigated (shared kernel) | Mitigated (VM boundary) | Mitigated |
| Payment replay | Mitigated | Mitigated | Mitigated |
| Fake attestation accepted | Mitigated (labelled + opt-in only) | Mitigated (labelled + opt-in only) | Fail-closed (verifier absent) |
| Snapshot/resume | No such feature | No such feature | No such feature |
| Side channels | N/A (no claim) | N/A (no claim) | **Residual** |
