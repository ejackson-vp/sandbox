# Security guarantees — what is enforced, what is simulated

Read this before making any claim about the system.

## 0. One sentence

The provider's **control plane, storage, logs and payment layer** never see
plaintext code or output in any mode. Only Mode C protects plaintext from the
**infrastructure operator** as well.

## 1. Guarantee matrix

| Property | Mode A (kind, `runc`) | Mode B (Kata VM) | Mode C (SEV-SNP/TDX) |
| --- | --- | --- | --- |
| No accounts / API keys | **Enforced** | Enforced | Enforced |
| One settled payment → one entitlement | **Enforced + tested** | Enforced | Enforced |
| API never receives plaintext | **Enforced + tested** | Enforced | Enforced |
| Control-plane logs/storage free of plaintext | **Enforced + tested** | Enforced | Enforced |
| Ephemeral key exchange per sandbox | **Enforced** | Enforced | Enforced |
| Customer verifies key binding | **Enforced + tested** | Enforced | Enforced |
| Attestation evidence is hardware-rooted | **NO — simulated** | **NO — simulated** | Designed; verifier unimplemented (fails closed) |
| Guest memory unreadable by host admin | **NO** | **NO** | Yes, with real hardware + Trustee |
| Kernel-level isolation from host | **NO** (shared kernel) | **Yes** (guest kernel) | Yes |
| Network isolation (pods/API/nodes/metadata) | **Enforced + packet-tested** | Enforced | Enforced |
| Proxy-only egress with private-destination denial | **Enforced + tested** | Enforced | Enforced |
| No inbound sandbox networking | **Enforced + tested** | Enforced | Enforced |
| 60 s execution cap | **Enforced (3 layers)** | Enforced | Enforced |
| No snapshots / persistence / resume | **Enforced by construction** | Enforced | Enforced |
| Ephemeral state destroyed | **Enforced + tested** | Enforced | Enforced |
| Customer isolation from other customers | **Enforced + tested** | Enforced | Enforced |

## 2. What "INSECURE_DEV_ONLY" means

In Modes A and B the guest signs its own attestation evidence with an Ed25519 key
whose seed is committed to this repository
(`deploy/kubernetes/02-secrets-dev.yaml`,
`shared/src/dev-attestation.ts`). Anyone can forge that evidence.

Therefore:

- Every envelope produced in these modes has `insecureDevOnly: true` and
  `hardwareBacked: false`.
- The CLI **refuses to run** without `--allow-insecure-dev`, and prints
  `Attestation: INSECURE_DEV_ONLY`.
- `verifyAttestation` in `confidential` mode rejects it with
  `not_hardware_backed` (unit-tested).
- The API/controller never *claim* confidentiality: pod annotations carry
  `x402.io/confidential: "false"` and a warning.

The dev override changes **nothing** about the confidentiality of the transport
or the control plane; it only acknowledges that the execution environment is not
confidential.

## 3. What the encryption actually protects

Protected against:

- the API server, controller, relay, facilitator, database, object storage,
  Kubernetes API objects, pod logs, tracing/metrics (none of them ever hold a
  decryption key),
- a passive network observer between CLI and relay (ciphertext only),
- another customer (different keys, different sessions),
- a compromised payment layer.

Not protected against:

- the node/host administrator in Modes A and B,
- a compromised guest in any mode (it must decrypt to execute),
- runtime side channels.

## 4. Crypto choices

| Purpose | Primitive | Library |
| --- | --- | --- |
| Code/result transport | X25519 + XSalsa20-Poly1305 sealed box (`crypto_box_seal`) | libsodium-wrappers (Node), x/crypto/nacl/box (Go) |
| Attestation signature (simulated) | Ed25519 over canonical JSON | Node `crypto`, Go `crypto/ed25519` |
| Payment authorization | EIP-712 typed data (EIP-3009 shape) | viem |
| Capability / relay token storage | SHA-256 hash | Node `crypto` |
| Proxy token | HMAC-SHA256, session-bound, TTL | Node `crypto` |

No cryptographic primitive is implemented from scratch. Interop between the Node
and Go sealed-box implementations is covered by an integration test that runs the
real Go guest.

## 5. Termination guarantees (and residual latency)

| Layer | Mechanism | Bound |
| --- | --- | --- |
| Guest watchdog | `context` deadline + process-group `SIGKILL` | exact duration (1–60 s) |
| Controller | independent deadline from persisted `execution_deadline_at`, +3 s grace, then delete pod | ≤ duration + ~3 s + delete latency |
| Kubernetes | `activeDeadlineSeconds = duration + 150 s` | backstop only |
| Reaper | pods older than 15 min or without a live session are deleted | ≤ 15 min worst case |

The 60 s cap is a **soft real-time** guarantee: `SIGKILL`, kubelet deletion and
CNI propagation all take time. A trusted node-level enforcer (e.g. a
hypervisor/kernel-enforced cgroup or a TEE-enforced watchdog) is required for a
hard guarantee; see `production-readiness.md`.

## 6. Explicit non-claims

This system is **not**:

- zero-knowledge computation. It is confidential computing plus encrypted
  transport. The provider's control plane sees *that* a job ran, its size and
  timing, and the payment identity.
- a defence against a malicious host in Modes A/B.
- a mixer/anonymity system. The payer address is visible to the facilitator and
  recorded with the session.
- a guarantee that customer code is correct or non-malicious.
- production-ready: see the gap list in `production-readiness.md`.
