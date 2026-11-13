# Threat model — x402 sandbox

Status: working-tree audit of `9d4bf54` (plus the fixes described in `FINDINGS.md`).
This is not a deployed build; no cluster stage was executed (see `EVIDENCE.md`).

## Assets

| Asset | Why it matters | Where it lives |
|---|---|---|
| Settlement authority | A settled EIP-3009 authorization must buy exactly one session | facilitator, `payments` / `payment_ledger` |
| Session capability | Bearer credential for exec, file transfer, suspend, destroy | HMAC, only its SHA-256 stored |
| Session plaintext | Commands, files, stdout/stderr | sealed X25519 boxes, client ↔ guest |
| Guest key material | Decrypts the client's envelopes | guest supervisor memory |
| Infrastructure credentials | Cluster-admin reachability | control-plane pods, node |
| Capacity | CPU/RAM/disk reservations, node slots | controller reservations |
| Ledger integrity | Refund duties, replay prevention | SQLite `payment_*` tables |

## Actors

1. **Anonymous internet client** — no account, can reach `POST /v1/sessions` and the status/operation routes.
2. **Paying malicious tenant** — owns a valid session and tries to escape it, attack the host, or attack another tenant.
3. **Stolen-receipt holder** — has a `PAYMENT-SIGNATURE` (logs, proxy, client compromise) but not the payer wallet.
4. **Malicious destination / DNS** — controls a hostname the guest resolves, or answers with private addresses.
5. **Compromised relay** — sees opaque frames, can drop/reorder/delay them.
6. **Compromised guest** — arbitrary code inside the sandbox, including root in the guest kernel.
7. **Insider / host admin** — can read control-plane memory and the database.
8. **Supply-chain attacker** — dependency, base image, GitHub Action, or release artifact.

## Trust boundaries

```text
client ──TLS──► API ──admin token──► controller ──k8s API──► kubelet ──► guest supervisor ──► user process
                  │                       │
                  └──► facilitator        └──► relay ◄── guest (outbound WS only)
                                                ▲
guest ──► egress proxy (CONNECT, HMAC token) ───┘
guest ──► workspace PVC (per session)
session A ──✗── session B   (capability + sealed envelopes + separate pods/PVCs)
operator/host ──► guest     (out of scope; Kata is the boundary, unverified here)
```

Boundaries that this review actually exercised: client→API, client→capability,
receipt→capability, guest→egress proxy, guest→filesystem/archive, controller→store.
Boundaries **not** exercised: guest→host (Kata), pod→pod and pod→API (Cilium),
controller→kubelet, facilitator→chain.

## Security assumptions

- The API terminates TLS; the capability and payment headers are not exposed to a
  network attacker. Everything below assumes that.
- `CAPABILITY_SECRET` and `CONTROLLER_ADMIN_TOKEN` are distinct and secret; the API
  refuses to start if they are equal or the capability secret is short.
- The egress proxy is the **only** egress path; `NetworkPolicy` denies the rest.
  The proxy's own controls are defence in depth for that assumption.
- The controller database is single-writer. Multi-replica controllers are not a
  supported configuration (SQLite, `BEGIN IMMEDIATE`).
- `PAYMENT_MODE=mock` has no economic security. Testnet settlement trust is the
  facilitator's; mainnet is rejected by configuration.

## Non-goals / explicit non-guarantees

- No account system: the capability is bearer and works from any IP until it expires.
- The control plane learns session metadata (tier, duration, payer, sizes) even
  though it never sees payloads.
- A full capture of the create request (payment header **and** the wallet
  signature) is equivalent to the client's authority. See F-07.
- Guest isolation strength is whatever the RuntimeClass provides. Development
  `runc` is not an isolation boundary.

## Attack paths considered

| # | Path | Boundary crossed | Outcome in this build |
|---|---|---|---|
| 1 | Replay a captured `PAYMENT-SIGNATURE` after settlement | receipt → capability | fixed: wallet proof required |
| 2 | Front-run a payment with the victim's header and own client key | receipt → guest key | fixed: proof recovers to the payer |
| 3 | Exhaust egress slots with concurrent CONNECTs during DNS | guest → proxy | fixed: atomic reservation |
| 4 | Leak slots by aborting during DNS | guest → proxy | fixed: half-close handling |
| 5 | Reach metadata / cluster IPs via CONNECT | guest → infrastructure | blocked, regression suite added |
| 6 | Reset a rate-limit penalty with high-cardinality payer keys | anonymous → API | fixed: bounded eviction |
| 7 | Buy 8× resources for the standard price | tenant → billing | fixed: resource-aware pricing |
| 8 | Upgrade drops the payment ledger | operator → money | fixed: additive migrations |
| 9 | Pull an image whose scan failed | supply chain → cluster | **open**: tags pushed before scan |
| 10 | Steal a capability and execute in the session | capability → plaintext | mitigated by sealed envelopes; execution still possible (bearer) |
| 11 | Escape the guest to the host | guest → node | **unverified** (Kata not tested) |
| 12 | Reach another tenant's pod or PVC | session A → B | **unverified** (Cilium not tested) |
| 13 | Present a stolen guest token on a reconnect | token → session | unchanged by reconnect: the token is the guest credential. The relay refuses a second socket while one is attached (409), and accepts a reconnect after the link drops until the lease ends. The controller does not re-verify attestation on reconnect, but the evidence and key are the same document the create verified. |

## Appendix — replay taxonomy and commitment verification

### Replay classes

| | Payment replay | Full-request replay | Capability recovery | Execution authority |
|---|---|---|---|---|
| Material | `PAYMENT-SIGNATURE` only | payment header + body + wallet signature | same as full request, by the owner | `x-sandbox-capability` |
| Yields | nothing (401 before capacity) | capability (F-07) | capability (by design) | exec/files/suspend/destroy |
| Bound by | `paymentKey` intent + wallet proof | static wallet proof | static wallet proof | capability hash + expiry |
| Cross-tenant | no | yes, if the whole request is captured | n/a | yes, if the capability leaks |

The distinction that matters: F-02 closed the **receipt-only** path (the realistic
leak: headers in logs/proxies). A **full-request** capture is strictly stronger
and is equivalent to the client retrying; closing it needs a server-issued
freshness nonce (PR 9) and is intentionally not done here.

### Commitment signature checks

| Property | Implementation | Verified by |
|---|---|---|
| Recovery | `viem.verifyMessage` (EIP-191 personal_sign) against `authorization.from` | integration tests (B's wallet → 401) |
| Domain separation | `domain: "x402-sandbox/client-commitment/v1"` + canonical JSON | unit-inspectable message; integration |
| Payment binding | `paymentKey` = SHA-256 of canonical `{version, network, scheme, asset, payTo, amount, payload}` | tampered-payment test → 401 |
| Chain binding | `accepted.network` is inside `paymentKey`; a mock commitment cannot authorize a testnet receipt | code-confirmed |
| Canonicalization | shared `canonicalJson` (sorted keys, `undefined` dropped) used by both SDK and API | SDK imports the same function |
| Versioning | commitment `v1`; capability HMAC prefix `v2` | F-08 release note |
| Failure behaviour | missing authorizer → 402; missing proof → 401; invalid/exception → 401; no capacity or intent write before verification | API-flow negative tests |
| Malleability | high-s ECDSA normalised by viem recovery | library behaviour |
| Contract wallets | EIP-1271 needs an RPC client; without one `verifyMessage` throws → 401 (fail closed) | code-confirmed |

### Pricing vs admitted limits

`resolveSessionSpec` produces the spec and the price from the same call, and the
controller re-resolves from the submitted `body.spec` and compares canonical JSON
before `completeEntitlement` (`controller/src/control-api/payments.ts`). A
tampered limit therefore either fails re-resolution or changes `specHash` and is
rejected. The property suite asserts the priced spec and the admitted spec are
identical and that tampering changes the hash (F-04).

## Appendix — STRIDE by component

Legend: **✔** control implemented and covered by an executed test or direct code
review · **◐** partial/mitigated with a stated residual · **✗** open finding ·
**?** unverified (no cluster/Kata execution in this audit). STRIDE letters:
S spoofing, T tampering, R repudiation, I information disclosure, D denial of
service, E elevation of privilege.

| Component | S | T | R | I | D | E | Status |
|---|---|---|---|---|---|---|---|
| Public API (`/v1/sessions`, session routes) | Payer wallet signature over the client commitment (F-02) | Zod schemas; `specHash` binds limits and client key | Payment intent + ledger row per payment; request-id cache | Ciphertext-only bodies; capability never logged | Per-IP and per-payer buckets (F-05); capability/read buckets | Capability scoped to one session and TTL | ◐ bearer capability + F-07 |
| Payment / facilitator integration | EIP-3009 signature; commitment must recover to `authorization.from` | `accepted` fields checked; amount/asset/payTo/network bound into `paymentKey` | Settlement transaction recorded on the ledger | No payload or key material logged | Intent stale reclaim; settlement timeout | Receipt alone is not authority | ◐ F-10 real-mode reconciliation |
| Controller internal API | Admin bearer token (cluster-internal) | Zod schemas; canonical spec re-resolution | State transitions are conditional SQL updates | Internal only; not exposed by ingress | No rate limit (network-isolated) | Admin token compromise = full control | ◐ no internal rate limit |
| Store (SQLite) | n/a | Prepared statements; UNIQUE payment/session constraints | Immutable ledger transitions (`SETTLED→REFUND_*` only) | Disk-level access is operator trust | Single writer, WAL, busy timeout; no HA | No dynamic SQL | ✔ F-03 tests |
| Capacity / admission | Holds keyed by payment key | Spec hash bound to the reservation | Reservation rows with TTL | No customer data | Global + per-session budgets; node capacity | Hold-before-settle prevents free capacity | ✔ |
| Relay | Per-session random token, stored hashed | Opaque frames; guest cannot forward arbitrary traffic | Request ids logged (no payload) | Frames are ciphertext; metadata remains | `MAX_PENDING`, TTL, response caps | Token scoped to one session | ✔ |
| Egress proxy | HMAC session token | Payload opaque | Allow/deny logged without payload | No payload state | Atomic per-session + global reservation (F-01) | Destination validation, exact-IP dial, no metadata/cluster reach | ✔ |
| Guest supervisor / runtime | Client key + attestation (dev attestation is explicitly insecure) | Sealed operations bound to session + nonce; request ids | Request id → one execution | Keys in memory, dumpable disabled; env scrubbed | Pids/CPU/mem/disk/file/timeout caps | Guest→host isolation | ? Kata unverified |
| Workspace / transfers / archives | n/a | SHA-256 on transfer completion; tar entry validation, `O_NOFOLLOW`, no links/devices | Transfer ids bound to the session | Per-session PVC; deleted at termination | Quotas before and after writes; entry/size caps | Traversal/symlink guards | ◐ no Go regression test (F-12) |
| Images / CI / release | GHCR token; provenance/SBOM | Tags can move; scan happens after publish (F-06) | Release notes with digests | No long-lived build secrets | n/a | Workflow token scope (F-15) | ✗ F-06, F-15 |
| Kubernetes / NetworkPolicy / RuntimeClass | No SA token mounted; default-deny | Cilium policies; RuntimeClass admission | Cluster audit logs (out of repo) | Default-deny ingress/egress | ResourceQuota/LimitRange | RBAC + Kata | ? not executed |

### STRIDE reading of the audit

- **Spoofing** was the weakest axis before this work: the API trusted a
  possession receipt for identity. It is now anchored to the paying wallet.
- **Repudiation** is covered for money (ledger + settlement tx) but not for
  operator actions; cluster audit logs are the only record there.
- **Information disclosure** is structurally strong (ciphertext-only control
  plane) and depends on the capability not leaking; the remaining exposure is
  metadata and the bearer nature of the capability.
- **Denial of service** had two real gaps (F-01, F-05), both fixed; per-payer
  durable budgets are still absent.
- **Elevation of privilege** is the least verified axis because it is the one
  that depends on Kata and Cilium, neither of which ran here.
