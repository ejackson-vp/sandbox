# Findings

Base revision: `9d4bf54` for F-01 to F-16, reviewed again at `5d4d50a` for
F-17 to F-20 (see [Delta review](#delta-review-5d4d50a)). F-21 was found by the
adversarial suite at `eea1569` and fixed on `test/adversarial-payments`. Follow-up
work is tracked as GitHub issues #31, #42–#48 and #64. See `EVIDENCE.md` and
`ADVERSARIAL-PAYMENTS.md`.
Severity is impact if exploited **in the configuration named in each entry**.
Confidence: `proven` (regression test), `code-confirmed` (read and traced, not
executed), `theoretical` (no concrete path found).

| ID | Sev | Confidence | Finding | Status |
|---|---|---|---|---|
| F-01 | High | proven | Egress proxy per-session limit bypassed by concurrent CONNECTs during DNS; slots also leaked on pre-DNS client abort | Fixed |
| F-02 | High | proven | A `PAYMENT-SIGNATURE` was a bearer receipt: replay yielded the session capability, and a header holder could bind the session to its own key | Fixed |
| F-03 | High | proven | Schema version mismatch dropped `payments`, `payment_ledger`, `payment_intents` and `sessions` | Fixed |
| F-04 | Medium | proven | Custom sessions were priced by duration only: 4 vCPU/8 GiB cost the same as 100m/128 MiB | Fixed |
| F-05 | Medium | proven | RateLimiter cleared the whole table past 10k buckets, resetting unrelated penalties | Fixed |
| F-06 | High | code-confirmed | Release images are pushed and tagged before the vulnerability scan; a failing scan leaves the tag pullable | **Fixed** in `release.yml` (staged tags, scan by digest, promote after scan); residual staging tag, see below |
| F-07 | Medium | code-confirmed | A *full* create-request capture was replayable forever: the commitment was a static signature over (paymentKey, clientPublicKey, clientNonce) | **Fixed** (#47) |
| F-08 | Low | code-confirmed | Capability derivation changed (`v2` HMAC); capabilities issued by an older build stop verifying after upgrade | Accepted |
| F-09 | Low | proven | Payer rate-limit key comes from the unverified `from` field; only the per-IP bucket bounds key rotation | Accepted (documented) |
| F-10 | High | code-confirmed | Testnet crash between settlement and entitlement had no reconciliation and no automatic refund | **Fixed for mock + review; unexecuted for real money** (#31) |
| F-11 | — | reviewed | CodeQL `js/missing-rate-limiting` ×9 | False positive (see below) |
| F-12 | — | reviewed | CodeQL `go/zipslip` (`archive.go:54`) | False positive, guards present |
| F-13 | — | reviewed | CodeQL `go/request-forgery` (`relay.go:61`) | False positive under the deploy assumption |
| F-14 | Low | reviewed | CodeQL `js/resource-exhaustion` (`registry.ts:181`) | Bounded; residual |
| F-15 | Medium | code-confirmed | GitHub Actions and base images pinned by tag, not digest/SHA | **Fixed**: every `uses:` is a 40-character SHA and every `FROM` is `@sha256:`; `scripts/check-deploy-pins.mjs` fails CI on drift between the overlay and the release |
| F-16 | — | reviewed | CodeQL `js/missing-rate-limiting` ×10 on controller/relay `/internal` routes | Fixed by shared TokenBucket; query model gap documented; alerts #217/#218 dismissed as false positive |
| F-17 | Medium | proven | The chain verdict proves the EIP-3009 **nonce was used**, not that this amount reached this address. The safety of that rested on an implicit invariant: the chain was only consulted after a successful `verifyPayment` for the same requirement | **Fixed**: the verifier proves the transfer (authorizer, recipient, amount) from the nonce's transaction; residual is the bounded scan window |
| F-18 | Low | code-confirmed | The runtime-class guard only runs when `EXECUTION_MODE=kata`. A cluster deployed with the default `dev` skips it, and the only signal is the `executionMode` field in the evidence | Accepted (dev is explicit); healthz now reports the resolved handler in every mode |
| F-19 | Medium | code-confirmed | Background settlement recovery in the controller still uses the facilitator lookup only, so a settled-but-unentitled payment is recorded as debt only if the client retries the create and the API resolves it from the chain | Open; the client-retry path is the gap |
| F-20 | Medium | code-confirmed | The allowlist is a free tier on the public create path. The credential is a long-lived wallet key held by the agent host that runs model-authored code, so a compromised host gets free sessions until the entry is disabled | Accepted with a tier ceiling and a concurrency cap; see below |
| F-21 | Medium | proven | A facilitator settlement record was trusted on `settled: true` alone: the recovery path granted a session without proving the recipient or the amount, so a payment a payer sent to itself bought a session | **Fixed**: the record must name the recipient it settled to and the amount that moved; see below |

---

## F-01 — Egress proxy connection accounting

**Attacker prerequisites:** any tenant (valid capability/egress token).
**Surface:** `CONNECT host:port` to the egress proxy.
**Boundary:** guest → proxy → file descriptors/slots of the shared proxy.
**CWE:** CWE-770 (resource allocation without limits), CWE-400.

**Expected:** at most `maxConnectionsPerSession` concurrent tunnels per session,
and one release per reservation on every exit path.

**Actual (base revision):**
`controller/src/egress-proxy.ts` checked `activeBySession` before `await dns.lookup`
and incremented it only after the lookup and `net.connect`. N concurrent CONNECTs
all observed the same count, so a session could open unbounded tunnels. A second
defect: upgraded HTTP sockets are `allowHalfOpen`, so a client that disconnected
during DNS produced `end`, not `close`; the reservation was never released and the
slot was held until the 10 s connect timeout.

**Effect:** cross-tenant availability. An unprivileged session can exhaust the
proxy's descriptor budget and deny egress to every other session.
**Affected configurations:** all deployments that use the proxy (the default).

**Fix:** a lease reserved synchronously before the first `await`
(`controller/src/egress-proxy.ts:129`), released idempotently on every path;
an independent `EGRESS_MAX_GLOBAL_CONNECTIONS` budget (default 512); client
`end`/`close`/data handling with a 64 KiB pre-tunnel buffer bound; the
pre-connect error handler is removed after connect so a late error cannot write
a 502 into an established TLS stream.

**Regression:** `tests/unit/egress-proxy.test.ts` — 32 concurrent CONNECTs with a
gated resolver and limit 4; failed/resolved/dial-error/abort/timeout release paths;
global budget across sessions; no 502 injection after connect.

**Residual:** the limit is per proxy process. With multiple proxy replicas the
effective aggregate is `replicas × maxGlobal`; that is a capacity choice, not a
bypass.

---

## F-02 — Payment receipt was bearer session authority

**Attacker prerequisites:** possession of another client's `PAYMENT-SIGNATURE`
(proxy logs, request capture, a shared client) — not the payer wallet.
**Surface:** `POST /v1/sessions`.
**Boundary:** receipt → session capability → guest key binding.
**CWE:** CWE-294 (authentication bypass by capture-replay), CWE-639 (IDOR).

**Expected:** a settled payment entitles exactly the client that paid, and the
session is bound to that client's key.

**Actual (base revision):**

- `capabilityFor(key)` derived the capability from the payment key alone, so a
  replayed receipt returned a working capability (`claim.status === "settled"`).
- `specHash(spec)` did not include `clientPublicKey`/`clientNonce`, so a header
  holder could submit their own client key and have the session bound to it if
  they won the race before the real client.

**Effect:** full session takeover (exec, file transfer, destroy). Confidentiality
of already-sealed payloads is not directly broken (the attacker lacks the client
X25519 private key), but the attacker controls the session and any new work.

**Fix:**

- `shared/src/commitment.ts`: canonical commitment
  `{domain: "x402-sandbox/client-commitment/v1", paymentKey, clientPublicKey, clientNonce}`.
- The **payer wallet** signs it (`personal_sign`). The API verifies with
  `verifyMessage` against `authorization.from` (`api/src/routes/create-session.ts:145`),
  before capacity or intent work.
- `SessionSpec.clientCommitment` makes the binding part of `specHash`, so the
  controller rejects a different client key with `spec_mismatch`.
- `capabilityFor(key, commitment)` (`api/src/server.ts`) is bound to both.
- The SDK signs with the same account that pays (`sdk/src/payment.ts`).

**Why this is not just an unverified JSON field:** the binding is only accepted
when an ECDSA signature over the canonical message recovers to the address in
the payment authorization. Changing `clientPublicKey` invalidates the signature;
changing the payment changes `paymentKey`; using another wallet recovers to the
wrong address.

**Regressions (integration, full stack + mock facilitator):**

- `does not let a receipt holder bind the session to their own client key` —
  B with A's header and B's wallet gets 401; A's request still succeeds.
- `does not return a capability to a client that only holds the receipt` — B's
  own wallet 401; A's wallet with a different client key 409 and no capability;
  A without proof 401; A with the original commitment still gets the capability.
- `recovers when the controller crashes after settlement but before entitlement` —
  asserts `countPayments` increments once, the retry returns 201, the replay
  returns the same capability, and no second payment row exists.

**Residual:** see F-07.

---

## F-03 — Destructive schema migration

**Attacker prerequisites:** none; triggered by an upgrade (operator action) or a
crash during upgrade.
**Surface:** `controller/src/store/schema.ts`.
**Boundary:** operator → financial ledger.
**CWE:** CWE-459 (incomplete cleanup) / data loss.

**Expected:** upgrading a schema preserves settled payments, ledger entries,
refund obligations and session identities; replay prevention survives.

**Actual (base revision):** `if (version !== SCHEMA_VERSION)` executed
`DROP TABLE` for `payments`, `payment_ledger`, `payment_intents`, `sessions` and
reservations. Any version bump erased the ledger. A downgrade to a *newer*
database also dropped it.

**Effect:** loss of the record of who paid, what was refundable, and which
payments were already redeemed. Replayed receipts become redeemable again.

**Fix:** additive, transactional migration ladder (`SCHEMA_VERSION = 8`); v7→v8
adds `sessions.client_signer`; a newer database is refused; fresh databases get
the current shape.

**Regression:** `tests/unit/migration.test.ts` — populated v7 upgrade preserves
payments/ledger/sessions/intents and UNIQUE replay prevention; backup/restore;
downgrade refusal; partial-upgrade rollback (duplicate column leaves version 7
and data intact); fresh database.

**Residual:** backups are still the operator's responsibility. The test covers a
process restart, not a torn write during `COMMIT` (SQLite WAL provides atomicity).

---

## F-04 — Custom pricing ignored CPU, RAM and disk

**Attacker prerequisites:** any paying client (self-selected custom limits).
**Surface:** `POST /v1/sessions` with `tier: "custom"`.
**Boundary:** tenant → billing/capacity.
**CWE:** CWE-682 (incorrect calculation), OWASP API4/API6.

**Actual (base revision):** `factor = max(0.1, duration / 300)`; price was
`$0.05 × factor` regardless of `cpuMillis`, `memoryMiB`, `diskMiB`. A 4 vCPU /
8 GiB / 8 GiB disk session for 300 s cost exactly the same as 100m / 128 MiB.

**Effect:** negative margin and capacity exhaustion at the cheapest price; a
tenant can reserve 8× the resources for the same fee.
**Affected configurations:** `ALLOW_CUSTOM_DURATIONS=true` (default).

**Fix:** `units = max(0.25, cpu/base, mem/base, disk/base)`;
`price = base × durationFactor × units`, integer arithmetic, round up
(`shared/src/tiers.ts:147`). Monotonic in each dimension.
`loadTiers` now rejects zero/negative/NaN prices and out-of-range leases.

**Regression:** `tests/property/pricing.test.ts` — explicit 8× case, monotonicity
in CPU/RAM/disk/duration (fast-check), no zero/NaN price, config rejection,
and "the spec that was priced is the spec that is admitted" (idempotent
resolution) plus a hash-change assertion for tampered limits.

**Residual:** preset tiers remain operator policy and can still be subsidised;
that is explicit, not a calculation bug. Baseline (scheduler reservation) is not
priced separately; peak is.

---

## F-05 — Rate limiter reset by high-cardinality keys

**Attacker prerequisites:** unauthenticated; can send payment headers with
arbitrary valid-looking `from` addresses.
**Surface:** the per-payer bucket in `api/src/admission.ts`.
**CWE:** CWE-770.

**Actual (base revision):** `if (this.buckets.size > this.maxBuckets) this.buckets.clear();`
A flood of 10 001 unique payer keys wiped every bucket, including a victim's
exhausted one, and reset the flood's own penalties.

**Fix:** bounded eviction (`evict(now, keep)`): drop fully-refilled buckets
first, then newest-first among penalised buckets, never the key being touched
(`api/src/admission.ts:53`).

**Regression:** `tests/unit/admission.test.ts` — 200 unique keys with a table of
8 leave the victim exhausted; the table stays bounded and fresh keys still work.

**Residual:** F-09 (payer identity is self-asserted) means an attacker can still
rotate identities; the per-IP bucket is the real bound. With `TRUST_PROXY_HOPS > 0`,
the deployment must ensure the proxy overwrites `X-Forwarded-For`.

---

## F-06 — Release tags published before the scan (FIXED, residual staging tag)

**Attacker prerequisites:** none; this is a process defect.
**Surface:** `.github/workflows/release.yml`.
**CWE:** CWE-1357 / supply chain.

**Actual:** the `images` job pushes `push: true` with the version/latest tags;
the `scan` job runs afterwards with `needs: images`; `release` needs the scan,
but the **image tags already exist and are pullable** when the scan fails. A
cluster that deploys by tag can pull a CRITICAL image even though the workflow is
red. The workflow comment acknowledges this.

**Effect:** the supply-chain gate is advisory for image consumers.
**Affected configurations:** any deployment pulling `ghcr.io/…-control:<tag>` or
`:latest` from a release run that failed scanning.

**Fix:** `release.yml` now pushes only a run-scoped `staging-<run-id>-<sha>`
tag. The `digests` job resolves the immutable index digest, `scan` gates that
exact digest, and `promote` adds the version and `latest` tags with
`imagetools create` only after both image scans and the isolation gate pass.
`release` depends on `promote`, so a red scan leaves no release tag. Provenance
attestations are attached to the same digests.

**Residual:** the run-scoped staging tag is still pullable from GHCR until it is
cleaned up, and nothing at admission time prevents a deployment from using it.
It is not a release artifact and is documented as such in
`docs/release-process.md`; the deployment manifests and Kyverno policy target
`repo@sha256:...` release digests, not `staging-*`.

**Status:** fixed in code. A future release run should confirm that a failed
scan leaves no version tag; that run is not in the retained evidence.

---

## F-07 — Full create-request capture is replayable only inside one challenge (fixed for #47)

**Attacker prerequisites:** read access to the complete request (TLS termination,
client-side compromise, verbose proxy capture), plus submission inside the
challenge TTL and before the real client's request lands. This is strictly
stronger than "has the payment header".
**What was wrong:** the request carried the payer's commitment signature over
`(paymentKey, clientPublicKey, clientNonce)`. Replaying it was,
cryptographically, the payer retrying after a crash — the API could not tell them
apart, and must not, or the documented crash-recovery path breaks. A captured
request therefore worked forever.

**Fix (#47):** the 402 challenge carries a server-issued, single-use
`challengeNonce` (`cn_` + 128 bits). It joins the commitment message under the
`x402-sandbox/client-commitment/v2` domain, so the wallet signature covers it.
The API burns it before holding capacity or settling:

| Burn answer | Meaning | Result |
|---|---|---|
| `burned` | first use | continue |
| `replay` | same payment, same nonce | continue (crash recovery) |
| `reused` | different payment | `402 challenge_nonce_reused` + fresh challenge |
| `expired` | past `CHALLENGE_NONCE_TTL_MS` (default 180 s) | `402 challenge_nonce_expired` |
| `unknown` | never issued, or pruned | `402 challenge_nonce_unknown` |

The client retries a rejected challenge with the **same payment payload** and a
new signature, so the payment key does not change and a settled payment recovers
its entitlement instead of being charged twice. State lives in the controller's
SQLite database (`challenge_nonces`), is pruned on a TTL and capped at
`CHALLENGE_NONCE_MAX_ACTIVE` (default 20 000) because issuing is an
unauthenticated write; the per-IP create bucket bounds the rate.

**Cost:** the SDK's cached-challenge fast path is gone (the nonce makes a cached
challenge unusable after one use), so a create takes one extra round trip. The
commitment domain is v2, so a capability minted by a v1 build cannot be replayed
into a v2 one; the API and SDK ship together.

**Regressions:** `tests/unit/challenge-nonce.test.ts` (burn/replay/reuse, TTL,
restart durability, cap, and the route refusing a spent nonce before capacity,
intent claim or settlement), `tests/unit/sdk-payment-nonce.test.ts` (no cache,
same payload on retry, no retry for a payment rejection),
`tests/integration/api-payments.test.ts` (full handshake and idempotent replay).

**Residual:** an attacker who captures the challenge *and* the signed request and
submits first wins that race. Without wallet proof on every capability use, a
capability remains a bearer token for its TTL (documented in
[security-guarantees.md](../docs/security-guarantees.md)).

---

## F-08 — Capability derivation version change (accepted)

`capabilityFor` now HMACs `x402-capability:v2:<paymentKey>:<commitment>` instead
of `x402-capability:<paymentKey>`. Sessions created by an older build cannot
authenticate after the upgrade even though `capabilityExpiresAt` has not passed.
This is an availability/compatibility note for a rolling upgrade, not a security
regression (it fails closed). Document in the release notes; drain or recreate
sessions across the upgrade.

---

## F-09 — Payer rate-limit key is self-asserted (accepted, deployment-dependent)

`paymentPayerKey` reads `payload.authorization.from` before the payment is
verified. An attacker can rotate that field to obtain fresh per-payer buckets.
The per-IP bucket still applies, and **only** when `TRUST_PROXY_HOPS` is correct:
`0` (default) uses the socket address; `>0` trusts that many `X-Forwarded-For`
hops. If the API is exposed directly with `TRUST_PROXY_HOPS > 0`, a client can
spoof the header and rotate IP buckets too.

**Affected configurations:** direct internet exposure with `TRUST_PROXY_HOPS > 0`
and no trusted proxy that overwrites the header. Recommended: keep it `0` unless
a proxy you control sets it.

**Mitigation added (#48):** a durable global create budget keyed on the constant
`global`, plus a global concurrent-session cap, checked after the client
commitment is verified and before any capacity hold or settlement. Rotating
`from` now buys a fresh *payer* row, not a fresh global row. The per-payer bucket
key is also checked after proof verification, so the "unverified field" framing
above no longer applies to the budget check itself: it applies only to the
in-memory bucket that runs before the proof.

---

## F-10 — Settlement reconciliation and refund execution (implemented, unexecuted against real money)

**Affected configuration:** `PAYMENT_MODE=testnet` (real settlement, no
`HttpSettlementLookup`; `UnsupportedSettlementLookup` is used).

**Scenario:** the facilitator settles the EIP-3009 authorization, then the API or
controller crashes before `completeEntitlement`. The client retries the same
payment. The facilitator answers `nonce_already_used`; the API has no lookup
(`settlementLookup.supported === false`), so it fails the intent, releases the
hold, and returns 402. The money moved; no session exists; no refund record is
created (the session row was never created, so `RefundService` never sees it).

The reverse crash window is covered in mock mode by `GET /settlements/:key`.
`RefundService` marks real-mode refunds `REFUND_PENDING` but **no worker or
runbook executes them**.

**Fix (#31):**

- `SettlementRecovery` walks intents `claimed` past
  `SETTLEMENT_RECOVERY_GRACE_MS`, asks the facilitator's settlement lookup, and
  on a settled payment writes a `REFUND_PENDING` ledger row with the synthetic
  session id `unsettled:<paymentKey>` and reason `settled_without_entitlement`.
  The debt is now recorded instead of lost. It does not fabricate an
  entitlement, and it leaves unsettled intents to the API retry path.
- `RefundWorker` executes `REFUND_PENDING` rows through an operator-configured
  `REFUND_WEBHOOK_URL`, conditionally (`status = 'REFUND_PENDING'`), with
  attempt counting, exponential backoff and a give-up limit. With no webhook it
  does nothing, which is the honest default.
- The ledger carries `settlement_nonce`, and the internal API can look up and
  refund by it, so a facilitator webhook or an operator can key on the EIP-3009
  nonce instead of the payment key.
- Double charge: a second signed payment for a client key pair that already owns
  a session is refunded (`duplicate_client_nonce`) and refused with
  `409 duplicate_session`, rather than creating a second session.

**What is still open:** nothing in this repository has moved real money. The
facilitator refund contract is defined here, not by a facilitator, and the
public testnet facilitator exposes no settlement lookup, so testnet still
answers `409 reconciliation_pending` for that window. The verdict stays
"do not advertise testnet/public payment as production-ready" until a real
settlement sandbox run proves it end to end.

**Regressions:** `tests/unit/settlement-recovery.test.ts` (recovery row, mock
auto-refund, unsettled intent untouched, no lookup no-op, idempotency, worker
success/backoff/exhaustion/no-executor, crash repair, duplicate charge in both
modes).

---

## Scanner imports (CodeQL / Dependabot / scorecard)

### F-11 `js/missing-rate-limiting` (9 alerts) — false positive, reviewed

Flagged: `api/src/server.ts:231` (the `POST /v1/sessions` registration) and every
`/v1/sessions/:id*` handler. Evidence: the create handler calls
`ipCreateLimiter.take()` and `createLimiter.take()` before any payment work
(`api/src/routes/create-session.ts:67,127`), and every session route calls
`authorize()`, whose first statement is `readLimiter.take(req.ip)`
(`api/src/routes/sessions.ts:20`). CodeQL does not follow the helper.
`api/src/mock-facilitator.ts:100` is the local fake facilitator; it is not part of
the production payment path and has no rate limit by design. **No change.**

### F-16 `js/missing-rate-limiting` ×10 (controller/relay) — fixed; query model gap documented

The metrics change added `recordAuthFailure(...)` calls, which made CodeQL see
the already-present authorization in `controller/src/control-api.ts` and
`controller/src/relay/http.ts` as an expensive action. Those internal listeners
are reachable only on the cluster network and are authenticated, but they had no
request-rate bound of their own.

**Fix:** `shared/src/rate-limit.ts` now provides a bounded token bucket (the API
limiter moved there unchanged) and a `rateLimit()` middleware. The controller
mounts it on `/internal` before `/internal/wake` and the auth middleware; the
relay mounts it on `/internal` before the handlers. Health and readiness probes
are deliberately mounted before the limiter so a saturated bucket cannot make a
healthy pod look unready. The key is the socket peer, the
scope is `internal`/`relay`, and a rejection is `429 {error:"rate_limited"}` plus
`sandbox_rate_limited_total{scope}`.

**Why the inline suppressions exist:** CodeQL's `RateLimitingMiddleware` models
only `express-rate-limit`, `express-brute`, `express-limiter`, and
`rate-limiter-flexible`; it does not follow a repository-owned middleware. The
two remaining `codeql[js/missing-rate-limiting]` comments in
`controller/src/control-api.ts` document that query-model limitation, not an
accepted risk. The relay route graph no longer performs an Express authorization
step: the mTLS `CN=controller` check runs on the authenticated TLS socket before
Express, so the relay no longer needs an inline suppression. The limiter's
burst/refill behavior, 429 response and bounded table are covered by
`tests/unit/rate-limit.test.ts`.

**Alert state:** the two comments above are on `main`, but code scanning did not
honour them, so alerts #217 (`/internal/wake`, line 110) and #218 (the `/internal`
auth middleware, line 132) stayed open. Both were dismissed as **false positive**
with a comment pointing at this finding and at the limiter mount
(`controller/src/control-api.ts:93`). The dismissal records a query-model gap, not
an accepted risk: nothing was silenced that is not bounded, and no auth or
rate-limit behaviour changed. Re-verification: `npx vitest run
tests/unit/rate-limit.test.ts` — 6/6 passing, including the over-burst
`/internal/wake` → `429 {error:"rate_limited"}` case.

The remaining code-scanning alerts are OpenSSF Scorecard process checks, triaged
in [#99](https://github.com/ejackson-vp/sandbox/issues/99).

### F-12 `go/zipslip` (`guest/internal/files/archive.go:54`) — false positive

`hdr.Name` is cleaned, absolute paths and `..` prefixes are rejected, `dest` is
prefix-checked against the workspace root, symlinks are rejected (both `Lstat` and
`O_NOFOLLOW`), only regular files/directories are accepted, and size/entry/quota
limits apply. CodeQL flags the `filepath.Join` before the prefix check.
**Recommendation:** add a Go table test for `../`, absolute, symlink and nested
entries so the property is pinned in the guest's own suite (not added here; the
TS suite is the one wired into `make verify`).

### F-13 `go/request-forgery` (`guest/internal/relay/relay.go:61`) — false positive under the deploy assumption

The URL comes from `RELAY_URL`, injected by the controller into the guest spec.
A tenant cannot set it. It becomes a real SSRF only if an attacker can modify the
pod spec/pod env, which already implies control-plane compromise. Documented as a
deployment assumption, not fixed.

### F-14 `js/resource-exhaustion` (`controller/src/relay/registry.ts:181`) — bounded

Pending requests are capped per session (`MAX_PENDING`), cached responses/errors
are TTL- and count-bounded, and each waiter is a single slot with a timeout.
No unbounded per-request growth found. Low residual: registry entries depend on
session purge/TTL; an operator should alert on relay entry count.

### F-15 Pinned dependencies (scorecard/CodeQL, 2 Dockerfiles + workflows) — open

GitHub Actions are referenced by major tag (`actions/checkout@v7`, etc.) and base
images by tag (`node:26-alpine`). A compromised upstream tag can execute in CI or
ship a different base. **Proposed:** pin actions to commit SHAs (Dependabot
updates them), pin base images by digest, and enable `docker` SBOM/provenance
(already produced) plus signature verification in the deploy path.

### Dependabot / secret scanning

No open Dependabot alerts and no open secret-scanning alerts at the time of
review. Seven Dependabot PRs were merged into `9d4bf54`; the test suite covers
the resulting majors (TypeScript 7, Vitest 5, Node 26 base).

---

## Delta review (`5d4d50a`)

458 commits and 607 files landed between `9d4bf54` and the revision this section
was written against. The audit was scoped to the trust boundaries that changed,
not to every line: payments and settlement, the new allowlist, the runtime-class
guard, egress accounting, API admission, the store migrations and the CI
workflows. Prose, tests, coverage and refactors with no behaviour change were
read only where they touched those paths.

Provenance, stated plainly: this review was written by the same assistant that
wrote most of the change. It is a code-and-process assessment by an interested
party, not an independent one. That is a weaker control than a second reviewer
and should be read as such. The release gate records it as a residual.

### F-17 — the chain verdict proves nonce use, not amount or recipient

**Attacker prerequisites:** a paying wallet, and a path where the chain answer is
consulted without a preceding successful verify.
**Surface:** `confirmSettledOnChain` (`api/src/payments/settlement-confirmation.ts`)
and its callers.
**Boundary:** on-chain state → entitlement.
**CWE:** CWE-345 (insufficient verification of data authenticity).

**Expected:** an entitlement is granted only when *this* transfer settled: this
payer, this nonce, this amount, this recipient.

**Actual:** `authorizationState(authorizer, nonce)` returns `true` once that
nonce is used, for any amount and any recipient. The verifier reads nothing else
from the chain.

**Why it is not exploitable today:** `verifyAndSettle` calls
`resourceServer.verifyPayment(payload, requirement)` with the server's own
requirement before it settles, and every recovery path that consults the chain
is reachable only after that verify returned `isValid`. The amount is therefore
bound by the verify, and the chain answer only answers "did it land".

**Effect if the invariant breaks:** a 1-atomic-unit EIP-3009 transfer with a
chosen nonce would entitle a session worth 50,000 units. That is a single
refactor away from being live: any new caller that consumes the chain verdict
directly, or a mis-ordered recovery branch, converts it into free sessions.

**Fix applied:** the verifier no longer reads `authorizationState`. It finds the
`AuthorizationUsed(authorizer, nonce)` log, reads that transaction's receipt, and
requires a `Transfer` on the same USDC contract from the authorizer to the
configured `PAY_TO` for at least the required amount. The call site also states,
and a test pins, that the chain is never consulted for a payload that failed
verification. Verdicts are `proven`, `disproven(reason)` and `not-found`, and
`not-found` is `unavailable` rather than a refusal so the reconciliation window
stays open.

**Residual:** the scan covers `PAYMENT_SETTLEMENT_LOOKBACK_BLOCKS` (default
90,000, about 50 hours on Base) in 10,000-block chunks, capped at 12 queries per
check. A nonce older than the window is `unavailable`, so it withholds rather
than resolving. The proof has not been exercised against a real provider's
`eth_getLogs` range cap or a real settle-then-crash.

**Residual:** the controller's background recovery still uses the facilitator
lookup only (F-19), so the chain answer is not used everywhere it could be.

### F-18 — the runtime-class guard is conditional on a label

**Surface:** `controller/src/config/kubernetes.ts`.
**Boundary:** configuration → the isolation level actually used.

The guard reads the `RuntimeClass` and refuses a non-microVM handler, but only
when `EXECUTION_MODE=kata`. With the default `dev`, no read happens. Isolation
itself comes from `runtimeClassName` on the pod, not from the label, so a
`dev` deployment on a `kata` RuntimeClass is still a VM; the risk is the reverse
case, a cluster whose RuntimeClass is `runc` and whose mode was left at `dev`.
That deployment advertises `executionMode: dev` in its evidence, and `/internal/healthz`
now reports the resolved handler in every mode, so the state is observable
rather than silent.

**Recommendation, not applied:** log a startup warning when
`KUBERNETES_ENABLED=true` and `EXECUTION_MODE=dev`, because that combination is
the one where an operator believes they have VMs and might not.

### F-19 — settled-but-unentitled recovery depends on the client retrying

**Surface:** `SettlementRecovery` in the controller.
**Boundary:** money moved → recorded obligation.

The API resolves a lost or ambiguous settle from the chain, so a client that
retries is made whole. If the API dies after settlement and the client never
retries, the controller's worker asks the facilitator's settlement lookup, which
the public testnet facilitator does not expose and CDP does not document, so no
`REFUND_PENDING` row is written. The money moved and no debt is recorded.

This is the remaining half of F-10: the forward path is fixed, the background
reconciliation is not. **Fix:** give the worker the same `ChainSettlementVerifier`
the API uses, keyed on the intent's stored authorizer and nonce.

### F-20 — the allowlist is a free tier on the public create path

**Surface:** `POST /v1/sessions` with `PAYER_ALLOWLIST_ENABLED=true`.
**Boundary:** a proven wallet address → an entitlement with no payment.
**CWE:** CWE-284 (improper access control) as the generic class; the design is
deliberate (ADR 0013) and the concern is the residual.

**Expected:** only an operator-added address is granted; only within its tier
ceiling and concurrency cap; only with a fresh single-use challenge; and the paid
path is unchanged for everyone else.

**Actual:** the check runs after `proveCommitment` and before any facilitator
call, keyed on the address recovered from the commitment signature, never on a
claimed field. Every refusal (missing row, disabled, tier, concurrency, different
signer) falls through to the paid path. A lookup failure answers `503` rather
than charging a wallet that is meant to be free. Budgets use a separate
`allow:<address>` namespace. Mutation testing kills every mutant in the module.

**Residual, accepted:** the credential is a long-lived wallet key, and for the
Hermes agent it sits on the host that executes model-authored commands. A host
compromise therefore yields free sessions until the row is disabled. The bounds
are the entry's `max_tier` and `max_concurrent`; the mitigation is to keep both
low and to alert on `sandbox_sessions_total{source="allowlist"}` volume. A
short-lived signed grant was considered and rejected on operational cost; if the
agent host is ever exposed, that trade should be revisited.

Free sessions also skip the facilitator, so they are not screened by the KYT and
OFAC checks a paying payment gets. The value of that is low, but it means an
allowlisted wallet is the one path into the service that is not compliance
screened.

### F-21 — a settlement record proves a key was used, not that this requirement was paid

**Attacker prerequisites:** a wallet, and a facilitator that will settle what its
caller asks it to. Settlement of a self-addressed EIP-3009 authorisation is a
valid transfer, so nothing exotic is needed.
**Surface:** `POST /v1/sessions`, the crash-recovery branch that reads
`GET /settlements/:paymentKey` (`recoverSettlement` in
`api/src/payments/settlement-confirmation.ts`).
**Boundary:** a facilitator's claim → an entitlement.
**CWE:** CWE-345 (insufficient verification of data authenticity).

**Expected:** a recovered payment entitles a session only when the source proves
*this* transfer: this payer, this nonce, at least this amount, to this `PAY_TO`.
F-17 established that for the chain. The lookup is a second source and has to
meet the same standard.

**Actual:** `recoverSettlement` granted on `record.settled === true`. The record
carried an `amount` and a `payer`, and nothing compared either to the
requirement the intent was claimed with. The module's own comment said the
opposite ("A recipient or amount taken from the request would let the payer
choose what settled means"), which is how the gap survived review: the argument
was made about the request, and the record was never held to it.

Reachable path, executed as a test: the payer posts a header that advertises the
server's amount and authorises 50,000 units **to itself**. `decodePayment`
checks the amount and the network, not the recipient, so it passes; the
facilitator refuses with `payto_mismatch` and the client gets a 402. That failed
verify releases capacity but leaves the payment intent `claimed`. The payer then
settles its own authorisation, waits out the claim lease (30 s by default), and
retries. The reclaimed intent answers `recovered: true`, `recoverSettlement`
runs before any verify, the chain has no verifier in mock mode, and the lookup
says `settled`. The API answered 201 with a capability and wrote a ledger row
claiming `amount 50000` to `PAY_TO` for a transfer that went to the payer.

**Why it was bounded to mock:** `createApp` wires `HttpSettlementLookup` only
when `PAYMENT_MODE=mock`; testnet and mainnet use `UnsupportedSettlementLookup`,
so `recoverSettlement` answers `unknown` and withholds. **The deployed mock
deployment was exposed**; testnet and mainnet never were. Two things made that
worth fixing rather than accepting:

- the mock path is the deployment the payment test suite runs against, so a
  shape that grants without the transfer weakens the evidence for the recipient
  property everywhere it is asserted;
- `HttpSettlementLookup` is not mock-specific. One `supported: true` on a real
  network would have turned a documented, unproven facilitator answer into an
  entitlement, and a real facilitator settles what it is asked to settle.

**Fix applied:** `SettlementRecord` gained `recipient`, alongside the `amount` it
already had, and both are now required for a grant. `recoverSettlement` decides
`settled` only when the chain proves the transfer or the record proves both:
`record.recipient` equal to the requirement's `payTo` (address shape checked,
compared case-insensitively, never a substring) and `record.amount >=
requirement.amount`. A record that cannot name either is `unknown`, which
withholds without closing the reconciliation window; a record that names another
recipient or a short amount positively contradicts the requirement and is
`disproven`, so it is refused rather than retried forever. The mock facilitator
(`api/src/mock-facilitator.ts`) now stores the recipient from the submitted
authorisation, next to the amount it already stored, and reports both from that
row rather than from anything the caller supplied. The controller's recovery
worker still treats `settled: true` as enough to record a debt, which is correct:
a debt needs to exist, an entitlement needs to be earned.

**Regression:** `tests/unit/settlement-record.test.ts` holds the verdict table
(correct record grants, wrong recipient refuses, short amount refuses, missing
recipient or amount withholds) and the end-to-end self-addressed attack that
started this; `tests/unit/mock-facilitator.test.ts` pins that the record reports
the authorisation's recipient and value and never stores a settlement it
refused; `tests/unit/payment-adversarial.test.ts` keeps the other 36 attacks.

**Residual:** a facilitator that lies about both fields is indistinguishable
from one that tells the truth, which is why the chain check takes precedence
wherever it exists and why mainnet refuses to start without one. A database
written by the previous mock facilitator reads its old rows as "settled but
unprovable" (the column is added as nullable), so an operator upgrading the mock
sees a withhold until that payment is settled again, never a bad grant.

---

## What this review does not cover

- **Kata isolation.** No run against real hardware. Cilium is proven in CI per
  pull request; the VM boundary is not.
- **Real money.** No settle and no refund has moved funds.
- **The guest binary.** The Go hardening and archive paths were not re-audited;
  F-12's guards are unchanged.
- **Dependencies.** No fresh advisory sweep; the runtime audit is clean and the
  five open advisories are dev-only tooling.
- **An independent reviewer.** See the provenance note above.
