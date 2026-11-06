# Architecture

## 1. What this system does

A customer (human or agent) pays once through x402 and receives a **leased
Linux sandbox**: a temporary computer with a fixed duration (1 minute to 30
minutes), hard CPU/memory/disk limits, a persistent `/workspace`, and an
arbitrary command execution API. The customer runs as many commands as they
want inside the lease, uploads and downloads files, and destroys the sandbox
early or lets it expire.

No accounts, no API keys, no plaintext commands or file contents on the
provider's control plane.

## 2. Components

```
                      ┌──────────────────────────────────────────┐
  SDK / CLI / agent   │  x402 payment  +  session capability    │
  ──────────────┬────►│  API server (stateless)                  │
                │     └───────┬──────────────────────────────────┘
                │             │ internal control API (token + NetworkPolicy)
                │             ▼
                │     ┌──────────────────────────────────────────┐     ┌──────────────┐
                │     │  Controller                              │────►│ Kubernetes   │
                │     │  - SQLite: payments, intents, sessions,  │     │ API (pods in │
                │     │    exec_requests                         │     │ sandbox ns)  │
                │     │  - reconciler: lease + cleanup           │     └──────────────┘
                │     └───────┬──────────────────────────────────┘
                │             │ admin HTTP
                │             ▼
                │     ┌──────────────────────────────────────────┐
                │     │  Session relay (opaque RPC switch)       │◄── guest-initiated
                │     │  request/response correlation by id      │    WebSocket (no inbound)
                │     └──────────────────────────────────────────┘
                │
                │  sealed envelopes only (commands, files, results)
                ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ sandbox-workloads namespace (tainted node, default-deny)      │
       │  ┌────────────────────────────────────────────────────────┐  │
       │  │ sandbox pod (runtimeClassName: x402-sandbox)            │  │
       │  │  guest supervisor (Go, non-dumpable)                    │  │
       │  │   - ephemeral X25519 key, attestation, sealed-box open   │  │
       │  │   - /workspace: memory emptyDir, or a per-session PVC   │  │
       │  │     for suspendable sessions                             │  │
       │  │   - one operation at a time, process-group watchdog     │  │
       │  │   - python3 / node / bash toolchain                     │  │
       │  └────────────────────────────────────────────────────────┘  │
       │        │ egress allowlist: relay:8443, egress-proxy:3128      │
       └────────┼─────────────────────────────────────────────────────┘
                ▼
       ┌──────────────────────┐
       │ egress proxy         │──► public HTTPS (443 only)
       │ session HMAC token   │    denies private/metadata/ULA/link-local/
       │ DNS pinned by IP     │    cluster/rebinding
       └──────────────────────┘
```

### API server (`api/`)

- Public, unauthenticated; x402 v2 protected `POST /v1/sessions`.
- Stateless. It verifies and settles payment, then asks the controller to
  materialise the entitlement.
- Never accepts plaintext: the only operation field is an opaque sealed box.
- Derives the session capability with HMAC(server secret, payment key) so a
  retried request recovers the *same* capability; stores only its SHA-256 hash.

### Controller (`controller/src/`)

Single writer for all state and the only component that mutates Kubernetes:

- atomic payment intent → settlement → entitlement (outbox),
- immutable lease deadline per session,
- single-operation gate per session, `requestId` idempotency,
- relays encrypted requests and responses, enforces deadlines,
- shutdown + pod deletion + relay purge,
- orphan reaping, crash recovery from SQLite.

### Session relay (`controller/src/relay.ts`)

An encrypted RPC switch, not a proxy or a tunnel:

- guest connects **out**; sandbox pods have no ingress rules at all,
- one connection per session, guest token checked against a stored hash,
- frames: `request`/`cancel`/`shutdown` down, `response`/`error` up,
- correlates opaque envelopes by id, caches responses for 5 minutes,
- rejects >8 pending requests per session and >24 MiB frames,
- cannot decrypt anything and cannot reach internal services.

### Guest supervisor (`guest/`, Go)

Runs for the whole lease:

- generates an ephemeral X25519 key pair per sandbox,
- produces attestation evidence bound to `{sessionId, guestPublicKey,
  clientPublicKey, clientNonce, measurement, kernel, tools}`,
- reads relay/proxy/dev credentials from a `0400` bootstrap file and deletes it
  before the first operation,
- marks itself non-dumpable (`PR_SET_DUMPABLE=0`) and caps `RLIMIT_NPROC`,
- decrypts each operation, validates the session/nonce/request binding,
- executes commands with a curated environment, per-command watchdog and
  process-group kill, capturing stdout/stderr separately with size caps,
- implements workspace-confined `file.put/get/list/stat` with tar support,
- refuses operations after the lease, kills descendants and exits.

### Egress proxy (`controller/src/egress-proxy.ts`)

- HTTPS `CONNECT` on 443 only; plain HTTP proxying refused,
- per-session HMAC token (Bearer or Basic from `HTTPS_PROXY`),
- resolves DNS itself, validates **every** address, connects to the validated
  IP literal (no rebinding window),
- denies loopback/RFC1918/CGNAT/link-local/metadata/multicast/reserved, IPv6
  ULA/link-local/NAT64/6to4/Teredo and IPv4-mapped forms, plus cluster CIDRs,
- refuses single-label hostnames, non-allowlisted ports and >16 tunnels/session.

### SDK and CLI (`sdk/`, `cli/`)

`@x402s/sdk` is the customer-side implementation of the protocol: payment
handshake, attestation verification, envelope sealing, operation polling,
reconnect by request id. The CLI is a thin shell over it and persists session
handles (id, capability, client key) locally with mode `0600`.

## 3. Session model

| Field | Source |
| --- | --- |
| session id | server-generated (`sbx_` + 12 random bytes) |
| tier / duration | requested tier or custom spec, validated against platform caps |
| CPU / memory / disk | tier defaults, mirrored into Kubernetes limits |
| max output / file size / command seconds / processes | platform limits |
| created / paid / ready / lease expiry | controller clock (immutable after READY) |
| capability | HMAC(payment key), hash stored server-side |
| state | `PAID → PROVISIONING → READY ⇄ ACTIVE → TERMINATING → terminal`; `READY/ACTIVE → SUSPENDING → SUSPENDED → RESUMING → READY` for suspendable sessions |

The lease starts at READY, so provisioning is free to the customer. The full
state machine and timing rules are in [sessions.md](sessions.md).

## 4. Payment design (x402 v2)

```
POST /v1/sessions (no payment)      → 402 + PAYMENT-REQUIRED (price for tier)
POST /v1/sessions (PAYMENT-SIGNATURE) → verify → settle → 201 + capability
```

The API uses `x402ResourceServer` from `@x402/core` for requirement
construction and header codecs, and the official `exact` scheme interfaces.

**Durable outbox.** `payment_intents(payment_key PK, status, session_id,
spec_hash)`:

1. `claim` — insert `claimed` (or return `settled`, `in_progress`, `failed`,
   `mismatch`).
2. settle through the facilitator.
3. `complete` — in one SQLite transaction: insert payment, insert session, mark
   the intent `settled`.

If the process dies between 2 and 3, a retry finds `claimed`, asks the
facilitator for the settlement record (mock facilitator endpoint), and completes
the entitlement without charging again. Where settlement lookup is unavailable
(real testnet/mainnet facilitators), the API answers `409
reconciliation_pending` rather than guessing.

One payment creates at most one session: the intent is keyed by payment,
`payments.payment_key` is UNIQUE, `sessions.payment_key` is UNIQUE, and the
facilitator rejects a reused nonce.

## 5. Confidentiality protocol

```
SDK                                       Guest supervisor
 │ create(clientPubKey, clientNonce)        │
 │──────────────────────────────────────────►│
 │                                           │ 1. X25519 keypair
 │                                           │ 2. evidence = Sign(sessionId,
 │                                           │    guestPub, clientPub, clientNonce,
 │                                           │    measurement, kernel, expiry)
 │ GET /v1/sessions/{id}                     │
 │◄──────────────────────────────────────────│ 3. evidence via relay
 │ 4. verify signature, bindings, freshness  │
 │ 5. Seal(op → guestPub)                    │
 │──────────────────────────────────────────►│ 6. Open, validate binding
 │                                           │ 7. execute / write file
 │                                           │ 8. Seal(result → clientPub)
 │◄──────────────────────────────────────────│
 │ 9. Open and display locally               │
```

Every operation is a separate sealed box with `{sessionId, clientNonce,
requestId, op, …}`, so the guest rejects cross-session or replayed payloads.
Results are sealed to the client key; the relay and control plane see ciphertext
and sizes only.

Crypto: libsodium `crypto_box_seal` (X25519 + XSalsa20-Poly1305) in Node,
`nacl/box.SealAnonymous` in Go (identical construction), Ed25519 attestation
signatures over canonical JSON produced by both implementations.

## 6. Kubernetes layout

| Namespace | Contents | Policy |
| --- | --- | --- |
| `sandbox-system` | api, controller, relay, egress-proxy, facilitator | default deny; per-component rules |
| `sandbox-workloads` | customer sandbox pods | default deny ingress+egress; egress only relay:8443 and egress-proxy:3128 |

- Dedicated node: tainted `x402.io/sandbox=true:NoSchedule`, selected by sandbox
  pods; control-plane pods pinned to the control-plane node.
- Pod Security Admission `restricted` (enforced + audited) on both namespaces.
- RuntimeClass `x402-sandbox` is mandatory and environment-specific (`runc` dev,
  `kata-*` for VM isolation).
- RBAC: controller may only manage pods in `sandbox-workloads` and read services
  in `sandbox-system`.
- No hostPath, no host namespaces, no SA token, no Linux capabilities, read-only
  root filesystem, seccomp `RuntimeDefault`, memory-backed workspace (or a PVC for checkpointed sessions).
- CNI: Cilium (kind's kindnet does not enforce NetworkPolicy). One Cilium-specific
  policy grants the controller access to the `kube-apiserver` entity; sandbox
  pods get nothing equivalent.

## 7. Trust boundaries

| Boundary | Trusted? | Consequence |
| --- | --- | --- |
| Customer SDK/CLI | untrusted | can spend money and read its own session |
| API server | trusted for payment validation | ciphertext + metadata only |
| Controller | trusted for lifecycle | ciphertext + metadata only |
| Relay | trusted for routing, not confidentiality | cannot decrypt |
| Kubernetes API/node (dev/Kata) | **trusted** | can read guest memory |
| Guest supervisor | trusted after attestation | holds plaintext briefly |
| Customer code | untrusted | unprivileged, workspace-confined, network-isolated |

## 8. Design decisions

- **Lease + operations, not a request/response executor.** A single-operation
  API cannot host `apt install`-style workflows. The supervisor is long-lived and
  the relay became a correlation switch.
- **One active operation per sandbox.** Deterministic filesystem semantics;
  concurrency is rejected (`409 busy`) rather than silently interleaved.
- **`requestId` as idempotency key.** Retries return the cached result; the SDK
  keeps the same id across reconnects.
- **Capability derived from the payment.** Solves "settled but response lost"
  without storing a plaintext secret.
- **File content inside envelopes, paths inside envelopes too.** The API learns
  neither file names nor contents.
- **tar in the guest, not the client.** Directory upload/download works without
  adding archive parsing to the control plane.
- **Outbox over best-effort.** A durable intent + facilitator lookup closes the
  settle/entitlement crash window for mock payments and fails closed elsewhere.
