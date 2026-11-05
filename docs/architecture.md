# Architecture

## 1. What this system does

A customer pays once through x402 and receives **one** execution of up to 60
seconds in an isolated sandbox. There are no accounts, no API keys, no cookies,
and no plaintext code ever reaches the provider's control plane. The customer's
code is encrypted to a key that only an attested guest holds, executed, and the
result is encrypted back to a key only the customer holds.

## 2. Components

```
                      ┌──────────────────────────────┐
  customer CLI/agent  │  x402 payment + capability   │
  ──────────────┬────►│  API server (stateless)      │
                │     └───────┬──────────────────────┘
                │             │ internal control API (token + NetworkPolicy)
                │             ▼
                │     ┌──────────────────────────────┐      ┌───────────────────┐
                │     │  Controller                  │─────►│ Kubernetes API    │
                │     │  - single-writer SQLite      │      │ (pods in sandbox  │
                │     │  - reconciler / deadlines    │      │  namespace only)  │
                │     │  - orphan reaper             │      └───────────────────┘
                │     └───────┬──────────────────────┘
                │             │ admin HTTP
                │             ▼
                │     ┌──────────────────────────────┐
                │     │  Session relay               │◄──── guest-initiated
                │     │  opaque blob switch only     │      WebSocket (no inbound)
                │     └──────────────────────────────┘
                │
                │  ciphertext in / ciphertext out
                ▼
       ┌────────────────────────────────────────────────────────────┐
       │ sandbox-workloads namespace (tainted node, default-deny)    │
       │  ┌──────────────────────────────────────────────────────┐  │
       │  │ sandbox pod (runtimeClassName: x402-sandbox)          │  │
       │  │  guest runtime (Go)                                   │  │
       │  │   - X25519 keypair, attestation, sealed-box open      │  │
       │  │   - write payload to memory-backed emptyDir           │  │
       │  │   - run python3 as unprivileged child, hard deadline  │  │
       │  │   - seal result to customer key, exit                 │  │
       │  └──────────────────────────────────────────────────────┘  │
       │        │ egress allowlist: relay:8443, egress-proxy:3128    │
       └────────┼───────────────────────────────────────────────────┘
                ▼
       ┌──────────────────────┐
       │ egress proxy         │──► public HTTPS (443 only)
       │ - per-session HMAC   │    denies private/metadata/ULA/
       │ - DNS pinned by IP   │    link-local/cluster/rebinding
       └──────────────────────┘
```

### API server (`api/`)

- Public, unauthenticated `POST /v1/sandboxes` protected by x402 v2.
- Holds no database. It verifies and settles payment through the facilitator,
  then asks the controller to create the entitlement.
- Never accepts `code`, `source`, `stdout`, `stderr` or `plaintext` fields.
- Issues a 32-byte random capability; only its SHA-256 hash is stored (by the
  controller). The capability is bound to one session id and expires (default
  15 minutes).

### Controller (`controller/src/`)

Single writer for all state (SQLite, WAL). Responsibilities:

- atomic payment redemption (`payments.payment_key` UNIQUE,
  `sessions.payment_key` UNIQUE),
- conditionally transition session state,
- create pods from a **fixed** template (no customer PodSpec, no customer image),
- register the session at the relay with a hashed guest token,
- mint a stateless HMAC egress-proxy token bound to the session,
- enforce provisioning and execution deadlines independently of the guest,
- delete pods, purge relay state, reap orphans (including after a crash).

### Session relay (`controller/src/relay.ts`)

A message switch, not a proxy:

- guest connects **out** over WebSocket, so sandbox pods need no inbound rules,
- one live connection per session, guest token checked against a stored hash,
- only accepts `hello`, `result`, `error` frames; forwards opaque base64
  envelopes it cannot decrypt,
- purges state when the session is destroyed; results expire after 120 s.

### Guest runtime (`guest/`, Go)

- generates an ephemeral X25519 keypair per boot,
- produces attestation evidence bound to `{sessionId, guestPublicKey,
  clientPublicKey, clientNonce, measurement, kernel}`,
- reads the relay/proxy credentials from a 0400 bootstrap file and deletes it
  before any customer payload arrives,
- opens the sealed box, validates the session/nonce binding, executes Python
  with a curated environment, enforces a wall-clock watchdog, kills the process
  group, seals the result to the customer key, exits.

### Egress proxy (`controller/src/egress-proxy.ts`)

- HTTPS `CONNECT` on port 443 only; plain HTTP proxying is refused,
- per-session HMAC token (Bearer or Basic),
- resolves DNS itself, validates **every** returned address, then connects to
  the validated IP literal (no second resolution ⇒ no rebinding window),
- denies loopback, RFC1918, CGNAT, link-local, metadata, multicast, reserved,
  IPv6 ULA/link-local/NAT64/6to4/Teredo, IPv4-mapped forms of all of the above,
  and deployment-supplied cluster CIDRs,
- refuses single-label hostnames and non-allowlisted ports.

### CLI (`cli/`)

`run` performs the whole flow: 402 → sign → settle → poll → verify attestation →
encrypt → execute → decrypt → destroy. `agent-demo` does the same using
`@x402/fetch`'s `wrapFetchWithPayment`, i.e. the standard agent integration path.

## 3. Payment design (x402 v2)

```
POST /v1/sandboxes                  → 402 + PAYMENT-REQUIRED (base64 JSON)
POST /v1/sandboxes  PAYMENT-SIGNATURE → verify → settle → 201 + capability
```

- The API uses `x402ResourceServer` from `@x402/core` for requirement
  construction, `decodePaymentSignatureHeader`/`encodePaymentRequiredHeader` for
  transport, and the official `exact` scheme interfaces.
- **Mock mode** (`mock:local`): a separate facilitator service speaks the real
  `/supported`, `/verify`, `/settle` HTTP contract. Payments are real EIP-712
  signatures over an EIP-3009-shaped authorization; verification and nonce
  tracking are real; settlement is off-chain and simulated. There is no money.
- **Testnet mode** (`eip155:84532`): the official `https://x402.org/facilitator`
  and `ExactEvmScheme`. `PAYMENT_MODE=testnet` plus a funded `EVM_PRIVATE_KEY`.
- Mainnet network ids are rejected at startup; there is no silent activation.

Why the API doesn't use the stock "settle after handler" middleware: one
payment must fund **exactly one** entitlement even under concurrent retries. The
API therefore does `verify → settle → atomic entitlement insert`, and the
facilitator's single-use nonce store makes double settlement impossible.

## 4. Confidentiality protocol

```
CLI                                   Guest (inside sandbox)
 │  create(clientPubKey, clientNonce)   │
 │─────────────────────────────────────►│  (via API, paid)
 │                                      │ 1. X25519 keypair (ephemeral)
 │                                      │ 2. evidence =
 │                                      │    Sign(sessionId, guestPub,
 │                                      │         clientPub, clientNonce,
 │                                      │         measurement, kernel, exp)
 │  GET /v1/sandboxes/{id}              │
 │◄─────────────────────────────────────│ 3. evidence via relay
 │ 4. verify signature + bindings       │
 │    + freshness + measurement policy  │
 │ 5. Seal(code → guestPub)             │
 │─────────────────────────────────────►│ 6. Open, validate binding
 │                                      │ 7. execute (60s watchdog)
 │                                      │ 8. Seal(result → clientPub)
 │◄─────────────────────────────────────│
 │ 9. Open, display locally             │
```

Crypto: libsodium `crypto_box_seal` (X25519 + XSalsa20-Poly1305, ephemeral
sender key bound into the nonce) in Node, `nacl/box.SealAnonymous` in Go — the
same construction. Attestation signatures are Ed25519 over canonical JSON that
both implementations produce identically (`tests/unit/crypto.test.ts`,
`tests/integration/protocol-local.test.ts`).

## 5. Lifecycle state machine

```
CREATED ──settle──► PAID ──pod created──► PROVISIONING
                                            │ guest hello (evidence bound)
                                            ▼
                                          READY ──execute──► RUNNING
                                            │                   │
                                            │                   ├─ result ──► COMPLETED ──► DESTROYED
                                            ├─ deadline ────────┴─► EXPIRED
                                            └─ failure ───────────► FAILED
```

- **CREATED** exists only inside the request that receives a payment; it is not
  persisted without a settled payment.
- The execution window starts at **READY** (provisioned + attested). `duration`
  is 1–60 s and cannot be extended by any API call.
- The pod is deleted at **COMPLETED** (execution state discarded immediately).
  The encrypted result stays in the relay for up to 120 s, then the session
  becomes **DESTROYED**.
- **EXPIRED** and **FAILED** are terminal; their pods are deleted and
  `destroyedAt` is recorded. They are not reported as successful executions.
- `activeDeadlineSeconds` (duration + 150 s) is a Kubernetes backstop only; the
  controller's own deadline (duration + 3 s grace) is the real enforcement.

## 6. Kubernetes layout

| Namespace | Contents | Policy |
| --- | --- | --- |
| `sandbox-system` | api, controller, relay, egress-proxy, facilitator | default deny; per-component allow rules |
| `sandbox-workloads` | customer sandbox pods | default deny ingress+egress; egress only to relay:8443 and egress-proxy:3128 |

- Dedicated placement: the worker node is tainted `x402.io/sandbox=true:NoSchedule`
  and sandbox pods select `x402.io/sandbox-pool=true`; control-plane components
  are pinned to the control-plane node.
- Pod Security Admission `restricted` on both namespaces (enforced, audited).
- RuntimeClass `x402-sandbox` is mandatory and environment-specific
  (`runc` → dev, `kata-qemu-coco-dev`/`kata-clh` → Kata, `kata-qemu-snp`/`-tdx` →
  confidential).
- RBAC: the controller can only create/delete/get/list pods in
  `sandbox-workloads` and read services in `sandbox-system`.

### CNI notes

kind's default kindnet does **not** enforce NetworkPolicy, so `deploy/kind/up.sh`
installs Cilium and the tests prove packet-level behaviour. One Cilium-specific
policy is needed: with `kubeProxyReplacement=false`, traffic to the in-cluster
API Service is DNAT'ed to a node IP before policy evaluation, and Kubernetes
`ipBlock` rules do not match the `kube-apiserver` identity. The controller
therefore also gets a `CiliumNetworkPolicy` with `toEntities: ["kube-apiserver"]`
(`deploy/kubernetes/cilium/controller-apiserver.yaml`). Sandbox pods get no such
rule.

## 7. Trust boundaries

| Boundary | Trusted? | Consequence |
| --- | --- | --- |
| Customer CLI/agent | untrusted | can only spend money and read its own session |
| API server | trusted for payment validation | sees ciphertext + metadata only |
| Controller | trusted for lifecycle | sees ciphertext + metadata only |
| Relay | trusted for routing, not confidentiality | cannot decrypt |
| Kubernetes API/node (Mode A/B) | **trusted** | can read guest memory; confidentiality claims are limited (see security-guarantees) |
| Guest runtime | trusted by the customer only after attestation | holds plaintext briefly |
| Customer code | untrusted | runs unprivileged in the sandbox |

## 8. Design decisions and alternatives

- **Go guest, TypeScript control plane.** The guest is small, static and easy to
  audit; the control plane reuses the official x402 TypeScript SDK.
- **Guest-initiated relay instead of an exposed port.** Keeps sandbox ingress
  empty, which is the strongest possible inbound posture.
- **SQLite single-writer instead of Postgres.** Zero external dependencies for a
  local prototype, while preserving the invariants (UNIQUE payment key,
  conditional transitions) that production needs.
- **Custom mock facilitator instead of a fake middleware.** Exercises the real
  x402 wire format and real signature verification, so client/agent code is the
  same code that would talk to a real facilitator.
- **No DNS in the sandbox.** The proxy resolves names for the customer; this
  removes DNS as an exfiltration and rebinding channel entirely.
