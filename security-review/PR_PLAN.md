# PR plan

The working tree contains fixes 1–5 combined (they share the integration
fixtures). Each is separable into the PRs below; the order avoids a schema
dependency inversion (the commitment PR needs the v8 column).

---

## PR 1 — `fix(store): additive schema migrations` (F-03)

**Complexity:** M · **Depends on:** none

- Replace the `version !== SCHEMA_VERSION → DROP TABLE` block with a
  transactional ladder; bump to v8 and add `sessions.client_signer`.
- Refuse a database from a newer build.
- Update the `store.ts` header comment that still says migrations are destructive.

**Acceptance:** `tests/unit/migration.test.ts` (5 cases) passes; a populated v7
database keeps payments/ledger/sessions/intents; downgrade and partial upgrade
fail closed without data loss.

---

## PR 2 — `fix(egress): reserve a slot before DNS and never leak it` (F-01)

**Complexity:** M · **Depends on:** none

- Lease reserved synchronously; idempotent release; global budget
  (`EGRESS_MAX_GLOBAL_CONNECTIONS`, default 512); config wiring.
- Handle `end` as well as `close` (allowHalfOpen), bounded pre-tunnel buffer,
  remove the pre-connect error handler after connect.

**Acceptance:** `tests/unit/egress-proxy.test.ts` — 32 concurrent CONNECTs with a
gated resolver never exceed 4; every failure path returns to 0; no 502 inside an
established tunnel; global budget holds across sessions.

---

## PR 3 — `fix(payments): bind the session capability to the paying wallet` (F-02)

**Complexity:** L · **Depends on:** PR 1 (column), PR 2 (not strictly)

- `shared/src/commitment.ts`: canonical message + authorizer extraction.
- `SessionSpec.clientCommitment` → part of `specHash`.
- API: verify `personal_sign` from `authorization.from` before capacity/intent
  work; **401** on missing/invalid proof; capability `v2` HMAC includes the
  commitment; pass `clientSigner` through complete.
- Controller: accept `clientCommitment` in the spec schema, store `client_signer`.
- SDK + CLI: sign with the paying account; remove the `wrapFetchWithPayment`
  path that cannot add the proof.

**Acceptance:**

- The two new API-flow negative tests and the crash-recovery positive test pass.
- Idempotent replay still returns the same capability; a settled payment still
  yields exactly one session.
- Update the public `CreateSessionRequest` doc: `clientSignature` is required on
  paid requests, optional on the 402 probe.

**Release note:** capabilities issued before this change stop working (F-08).
Drain or recreate sessions across the upgrade.

---

## PR 4 — `fix(billing): price custom sessions by CPU, RAM and disk` (F-04)

**Complexity:** S · **Depends on:** none

- Resource units against the standard tier, integer atomic math, round up.
- Validate `SESSION_TIERS` overrides (positive price, safe duration/resources).

**Acceptance:** `tests/property/pricing.test.ts` (8 checks, 500 generated cases);
the 4 vCPU/8 GiB and 100m/128 MiB cases diverge; no zero/NaN price; priced spec
equals admitted spec.

---

## PR 5 — `fix(admission): evict buckets without resetting penalties` (F-05)

**Complexity:** S · **Depends on:** none

- Replace `buckets.clear()` with bounded eviction; never evict the current key.

**Acceptance:** `tests/unit/admission.test.ts` — 200 unique keys leave a victim
exhausted; table bounded; fresh keys still work.

---

## PR 6 — `ci(release): promote images only after a passing scan` (F-06)

**Complexity:** M · **Depends on:** none · **Needs a real tag run to validate**

- `images` pushes only `staging-<sha>` (or an untagged digest).
- `scan` scans by digest.
- `promote` retags the version and `latest` only on success.
- `release` depends on `promote`.

**Acceptance:** a deliberately failing scan produces **no** version or `latest`
tag; a passing run produces both; the GitHub release body keeps the digest/SBOM
claims truthful.

---

## PR 7 — `fix(payments): reconcile and refund real settlement` (F-10)

**Complexity:** L · **Depends on:** none

- Settlement lookup for testnet (nonce/authorization query) or a durable
  "settled-unprovisioned" outbox written before the facilitator call.
- A refund worker that executes `REFUND_PENDING` (or a documented manual runbook
  with an auditable ledger export) for real modes.
- End-to-end sandbox test: crash after settle → retry yields the entitlement or a
  refund row with a transaction id.

**Acceptance:** no path where a real settled payment ends without an entitlement,
credit or refund record; double settlement is impossible.

---

## PR 8 — `ci: pin actions and images, scope tokens` (F-15, TokenPermissions)

**Complexity:** S–M · **Depends on:** none

- Pin every `uses:` to a commit SHA (Dependabot keeps them current).
- Pin base images by digest.
- Move `packages: write` from workflow level to the `images` job; `packages: read`
  for `scan`; keep `contents: read` at top level.
- Verify image signatures/digests in the deploy path.

**Acceptance:** CodeQL `PinnedDependenciesID` / `TokenPermissionsID` alerts close;
release still publishes both architectures.

---

## PR 9 — `feat(payments): freshness nonce for the client commitment` (F-07, optional)

**Complexity:** L · **Depends on:** PR 3

- Add a server-issued, single-use challenge nonce to `PAYMENT-REQUIRED` and
  include it in the signed commitment. Burn and TTL it server-side.
- Keep the cached-challenge path working (either per-challenge nonce reuse with a
  short TTL, or accept one extra round trip).

**Acceptance:** replaying a captured full request after its nonce is burned fails;
the legitimate crash-recovery path (fresh signature by the payer) still succeeds.
Only do this if full-request capture is in the threat model for the target
deployment.

---

## PR 10 — `ci(security): run Kata and Cilium suites on a disposable cluster` (gate)

**Complexity:** M + infrastructure · **Depends on:** none

- A trusted runner with a disposable kind + Cilium cluster for the network suite,
  and a separate real Kata class for isolation.
- Record the tested image digests in the run; fail the release if the suite did
  not run.
- Add the Go archive traversal table test (F-12) to the guest suite.

**Acceptance:** a release cannot be cut without a green isolation run whose image
digests match the promoted ones.
