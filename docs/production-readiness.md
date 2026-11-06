# Production readiness

This is a working local proof of concept of a general-purpose leased sandbox.
Below is every gap between it and a production service, ordered by risk, with the
concrete next step.

## 1. Blocking gaps

| # | Gap | Why it matters | Next step |
| --- | --- | --- | --- |
| 1 | **No hardware attestation** | dev/Kata evidence is signed by a published key | implement the TEE verifier + guest attestation-agent integration (Mode C) |
| 2 | **Shared host kernel in dev mode** | container escape is possible for hostile code | require Kata (Mode B) minimum; validate before launch |
| 3 | **SQLite single writer** | one controller, one node's PVC, no HA | Postgres/DynamoDB with conditional writes; keep UNIQUE payment key and conditional transitions |
| 4 | **Relay is a single in-memory pod** | restart loses pending ciphertext and sessions in flight | Redis/NATS with per-session queues and TTLs (ciphertext only) |
| 5 | **Settlement recovery is mock-only** | only the mock facilitator exposes a settlement lookup | add on-chain/testnet reconciliation (nonce used ⇒ settled) or facilitator webhooks; until then the API fails closed with `409 reconciliation_pending` |
| 6 | **No refunds** | a settled payment whose provisioning fails is not returned | define policy: automatic refund job or credit; requires a settlement ledger |
| 7 | **Image not pinned by digest** | a compromised controller could run another image | config now refuses a non-`sha256` digest when `ALLOW_INSECURE_DEV=false`; add Kyverno/sigstore admission and CoCo encrypted images for Mode C |
| 8 | **Secrets in the repo (dev)** | dev attestation key, admin/capability/proxy secrets | external secret manager; remove the dev key entirely in production |
| 9 | **Checkpoint workspaces are plaintext PVCs** | node/storage admins can read suspended session files; local-path has no encryption | use an encrypted StorageClass / CSI encryption, document the trust boundary, and expire PVCs aggressively |
| 10 | **No memory snapshot** | resume loses processes, memory and open sockets; this is disk-only | Firecracker snapshot or Kata/CRIU on a KVM host; until then call it a checkpoint, not a snapshot |
| 11 | **Suspend/resume pricing undefined** | a resume starts a fresh lease in the mock model | bill active time + storage, or charge per resume; decide before charging real money |
| 12 | **Checkpoints are node-pinned** | local-path PVCs cannot resume after node loss; `resume_unavailable` is fail-fast, not HA | RWX/network storage or Firecracker snapshot/restore before promising node-failure recovery |

## 2. Security hardening backlog

- **Per-session mTLS** between API and controller instead of a shared bearer
  token (NetworkPolicy is the only other control).
- **Capability derivation trade-off**: capabilities are HMAC(payment key) so a
  retried request can recover them. A leaked `PAYMENT-SIGNATURE` after settlement
  could recover the capability. Mitigation options: short capability TTL (already
  lease+15 min), encrypting the capability at rest for recovery instead of
  deriving it, or one-time recovery tokens. Document and decide before launch.
- **Evidence validity window** is lease + 5 min so a CLI can re-attach mid-lease.
  If you require very fresh evidence, store the verified guest key client-side and
  skip re-attestation after the first verification.
- **Relay authentication**: bind the guest token to a projected pod identity in
  addition to the bearer token.
- **Seccomp profile**: `RuntimeDefault`; ship a custom profile for the toolchain.
- **Egress allowlist by hostname** (`EGRESS_ALLOWED_HOST_SUFFIXES`) is available
  but disabled; enable it for abuse reduction.
- **Package installs**: document proxy-aware commands (`pip --proxy`,
  `npm config set proxy`, `git -c http.proxy=…`); consider a caching proxy.
- **Audit log** of payment → session → operation counts → outcome, hash-chained.
- **Rate limiting** is per-replica in memory; move to a shared limiter.
- **Workspace race**: path validation is TOCTOU-safe for the customer's own
  session only (single tenant). A second process could race the check; the
  workspace is single-customer, so the impact is self-inflicted.
- **Suspend/resume**: the capability is extended to `maxLifetimeSeconds`, so a
  leaked capability remains valid across suspends. The workspace PVC is a new
  at-rest data store; include it in backup/retention/encryption policy.
- **Suspendable sessions bypass the warm pool**: first READY and resume are cold
  (~0.9–5.8 s on the local rig), so the pool does not hide the checkpoint cost.

## 3. Reliability / operations

- Controller HA with leader election or a single-writer queue (deliberately
  single-writer today).
- Persist relay state so a relay restart does not fail paid sessions (or fail and
  refund them cleanly).
- Metrics: sessions created/expired/failed, provisioning latency, operation
  latency, timeouts, cancelled operations, relay pending, proxy denials by reason,
  reaper actions, orphan pods, intent recovery count.
- Alerts: controller/relay/API down, provisioning timeout rate, settlement
  failures, `reconciliation_pending` > 0, PVC full, pods without a live session.
- Load test: 100+ concurrent sessions; measure reconcile p95, relay fan-out, API
  latency for 8 MiB uploads.
- Backup/restore of the SQLite metadata (sessions are disposable; payment records
  are not).

## 4. Session product policy

- **Maximum lease**: 30 minutes by default (hard ceiling 1 h). Longer leases
  increase the blast radius and idle cost; decide deliberately.
- **Idle expiry**: currently a session burns its lease even if unused. Consider
  reducing the tier price or adding a short grace window.
- **Operation concurrency**: one foreground operation per sandbox. If customers
  need parallelism, add a second slot with explicit filesystem semantics rather
  than silently interleaving.
- **Background processes** are killed at command end; document this
  (`nohup`/daemons do not survive).
- **Abuse**: arbitrary code execution requires a content/abuse policy, takedown
  process and per-payer controls. The capability model is anonymous by design;
  payment is the only identity.

## 5. Payments

- Testnet: `PAYMENT_MODE=testnet`, `EVM_PRIVATE_KEY`, official
  `https://x402.org/facilitator`, network `eip155:84532`. Verify with a funded
  wallet:
  ```bash
  EVM_PRIVATE_KEY=0x… ./cli/dist/index.js create --tier short \
    --payment-mode testnet --allow-insecure-dev --api-url https://api.example
  ```
- Before mainnet: production facilitator, pinned network id, settlement
  reconciliation, refunds for failed provisioning, per-payer spend caps,
  and a documented incident path for double-charge disputes.
- Mainnet is rejected at startup (`api/src/config.ts`).

## 6. Isolated production target (Kata)

- Deploy on Linux hosts with KVM, install the CoCo chart, use
  `kata-qemu-coco-dev` (or `kata-clh` on kind).
- Re-run `make security-test` against the Kata deployment and record:
  guest kernel differs from host, no hostPath/host namespaces, network isolation
  unchanged, attestation labelled as non-hardware.
- Do **not** advertise provider-blind execution: Kata gives VM isolation, not
  hardware-rooted confidentiality.

## 7. Definition of "production confidential"

Only when all of the following are evidenced:

1. `kata-qemu-snp`/`kata-qemu-tdx` on real TEE hardware.
2. Evidence comes from the TEE, bound to the session key and nonce.
3. The client verifies it through an independent verifier and checks measurements.
4. Simulated, stale, wrong-`report_data` and downgraded evidence are rejected.
5. KBS releases image/secret keys only to an attested guest.
6. A negative test shows a modified image fails attestation.

Until then the honest description is: *encrypted in transit and opaque to the
provider's control plane; execution is not hardware-confidential.*
