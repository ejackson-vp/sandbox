# Findings

Base revision: `9d4bf54`. Fixes merged in `381dad3` (PR #36); follow-up work is
tracked as GitHub issues #31, #42–#48 and #64. See `EVIDENCE.md`.
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
| F-06 | High | code-confirmed | Release images are pushed and tagged before the vulnerability scan; a failing scan leaves the tag pullable | **Open** |
| F-07 | Medium | code-confirmed | A *full* create-request capture was replayable forever: the commitment was a static signature over (paymentKey, clientPublicKey, clientNonce) | **Fixed** (#47) |
| F-08 | Low | code-confirmed | Capability derivation changed (`v2` HMAC); capabilities issued by an older build stop verifying after upgrade | Accepted |
| F-09 | Low | proven | Payer rate-limit key comes from the unverified `from` field; only the per-IP bucket bounds key rotation | Accepted (documented) |
| F-10 | High | code-confirmed | Testnet crash between settlement and entitlement has no reconciliation and no automatic refund | **Open** |
| F-11 | — | reviewed | CodeQL `js/missing-rate-limiting` ×9 | False positive (see below) |
| F-12 | — | reviewed | CodeQL `go/zipslip` (`archive.go:54`) | False positive, guards present |
| F-13 | — | reviewed | CodeQL `go/request-forgery` (`relay.go:61`) | False positive under the deploy assumption |
| F-14 | Low | reviewed | CodeQL `js/resource-exhaustion` (`registry.ts:181`) | Bounded; residual |
| F-15 | Medium | code-confirmed | GitHub Actions and base images pinned by tag, not digest/SHA | **Open** |
| F-16 | — | reviewed | CodeQL `js/missing-rate-limiting` ×10 on controller/relay `/internal` routes | Fixed by shared TokenBucket; query model gap documented; alerts #217/#218 dismissed as false positive |

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

## F-06 — Release tags published before the scan (OPEN)

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

**Proposed fix (not implemented; needs a real release run to validate):**
push only an immutable staging tag/digest (`staging-<sha>`), scan by digest,
then a `promote` job uses `docker buildx imagetools create` to add the version and
`latest` tags only after the scan passes. `release` should depend on `promote`.

**Status:** open. Blocks the public-payment beta verdict.

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
`tests/integration/api-flow.test.ts` (full handshake and idempotent replay).

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
a proxy you control sets it, and add a global create budget independent of both
keys. Not changed here because the correct value is deployment-specific.

---

## F-10 — Testnet reconciliation and refunds are not implemented (OPEN)

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

**Status:** open. Do not advertise testnet/public payment as production-ready.
Blocks the "public beta with payment enforcement" verdict. Mock/local is
unaffected (lookup is supported and refunds are applied).

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
