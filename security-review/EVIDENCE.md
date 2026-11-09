# Evidence

## Environment

| Item | Value |
|---|---|
| Repository | `https://github.com/ejackson-vp/sandbox` (local checkout) |
| Base revision (audit start) | `9d4bf54dec2f8166c1194152375f605fec47f274` |
| Fixes merged | `381dad3` (PR #36), docs correction `b52a340` (PR #51), pins/tokens `dd44e93` (PR #62) |
| Patch | 24 files, +565/−147 in #36, plus the new regression suites |
| Node / npm | `v26.5.0` / `11.17.0` |
| Go | `go1.26.4 darwin/arm64` |
| Runtime under test | local processes: API, controller, relay, egress proxy, `LocalProvisioner`, real guest binary (**not** a microVM) |
| Payment mode | `mock:local` with the repository's fake facilitator |
| Kubernetes | `kubectl` context is `graphn-beta`, **not** a disposable sandbox. No cluster test was run. |
| Kata / Cilium | **NOT TESTED** |

The base revision is the deployed-test SHA for the offline stages. No image was
built or deployed during this review, so there is no cluster SHA to report.

## Commands and results

All commands were run from the checkout root.

| Command | Result |
|---|---|
| `make verify` | PASS — build, typecheck, structure lint, unit **146/146** (21 files), property **31/31** (3 files) |
| `make test-integration` | PASS — **50/50** (2 files) |
| `npx vitest run tests/unit/egress-proxy.test.ts` | PASS — 6/6, ~270 ms |
| `npx vitest run tests/unit/egress-ssrf.test.ts` | PASS — 24/24 |
| `npx vitest run tests/unit/migration.test.ts` | PASS — 5/5 |
| `npx vitest run tests/property/pricing.test.ts` | PASS — 8/8 |
| `npx vitest run tests/unit/admission.test.ts` | PASS — 6/6 (2 new) |
| `npx markdownlint-cli2 "security-review/*.md"` | PASS — 0 issues |

Test totals after the patch: **227** (146 unit + 31 property + 50 integration),
up from 177.

## Regression evidence per finding

The tests below were added with the fixes. They assert the fixed behavior; the
vulnerable behavior is established by the base-revision code paths quoted in
`FINDINGS.md`. A pre-fix run artifact was not retained (the new tests use test
seams that do not exist in the base revision).

### F-01 — egress accounting

`tests/unit/egress-proxy.test.ts`:

- 32 CONNECTs, limit 4, resolver gated on a barrier → exactly 4 reservations
  while DNS is unresolved, 28 × `429`, and the counter never exceeds 4.
  Base revision: all 32 passed the `current >= maxPerSession` check before the
  await and each incremented afterwards.
- Failed resolve ×6 → `active === 0` after each, and a further attempt is still
  admitted (no stuck/negative counter).
- Dial error, client abort during DNS, global budget (3 of 12), and
  "no 502 written into an established tunnel" all assert `active === 0` at the end.

### F-02 — receipt replay and client binding

`tests/integration/api-flow.test.ts` (full stack, real guest process):

| Test | Assertion |
|---|---|
| `does not let a receipt holder bind the session to their own client key` | B with A's header, B's wallet, B's client key → **401 `client_proof_invalid`**; no session; A's request then **201** |
| `does not return a capability to a client that only holds the receipt` | B's wallet → 401; A's wallet signing a different client key → **409**, no `capability` field; A without proof → **401 `client_proof_required`**; A with the original commitment still authorizes a status read (200) |
| `recovers when the controller crashes after settlement but before entitlement` | first attempt 503; `countPayments` +1 exactly; retry 201; replay 200 with the **same capability**; `countPayments` still +1 |
| `creates exactly one session for one payment and replays idempotently` | unchanged, still 201 then 200 with the same session and capability |
| `cannot create multiple sessions under concurrent retries` | 6 parallel posts still produce one session |

The tampered-payment test now expects **401 `client_proof_invalid`** (the
commitment no longer covers the modified payment key) instead of the later 402.

### F-03 — migration durability

`tests/unit/migration.test.ts` builds a populated v7 database:

- upgrade → `user_version = 8`, payments 1, ledger 1, sessions 1, intents 1,
  `client_signer` present and `NULL` for old rows; a duplicate payment key still
  violates UNIQUE.
- backup file restored and upgraded → same counts.
- `user_version = 999` → throws `refusing to downgrade`; data untouched.
- partial upgrade (column already present, version 7) → throws and rolls back;
  version stays 7, rows intact.
- fresh database → current schema.

### F-04 — pricing

`tests/property/pricing.test.ts`:

- 100m/128 MiB < standard < 4 vCPU/8 GiB at the same duration.
- 200 random specs: price > 0 and formats as `$d+(.d{1,6})?`.
- 150 random monotonicity checks across CPU, memory, disk and duration.
- 150 checks that re-resolving the admitted spec returns the identical canonical
  spec and price (priced spec == admitted spec).
- Tampering with admitted limits changes `specHash`.
- `SESSION_TIERS` rejects `$0`, `-1`, `$NaN`, `free`, `$0.000000`, and leases
  beyond `MAX_LEASE_SECONDS`.

### F-05 — rate limiting

`tests/unit/admission.test.ts`:

- victim exhausted with capacity 1; 200 unique keys against a table capped at 8;
  victim still refused, `retryAfterSeconds > 0`.
- 500 unique keys keep the table bounded and a fresh key still gets its first
  token.

## Scanner evidence

At audit start (`9d4bf54`): 60 open CodeQL alerts — 39 `PinnedDependenciesID`,
10 `js/missing-rate-limiting`, 3 `TokenPermissionsID`, 1 each `go/zipslip`,
`go/request-forgery`, `js/resource-exhaustion`, 5 scorecard/process IDs.

After the fixes (`dd44e93`, Scorecard re-run):

| Rule | Open | Resolution |
|---|---|---|
| `PinnedDependenciesID` | 0 | all actions pinned to SHAs, images to digests (#62) |
| `TokenPermissionsID` | 0 | permissions scoped per job (#62) |
| `VulnerabilitiesID` | 0 | `x/crypto` bumped past GO-2026-5932 (openpgp not imported) |
| `js/missing-rate-limiting` ×10 | 0 | dismissed as reviewed false positives (F-11) |
| `go/zipslip`, `go/request-forgery`, `js/resource-exhaustion` | 0 | dismissed with justification (F-12…F-14) |
| `CodeReviewID`, `MaintainedID`, `CIIBestPracticesID` | 3 | process signals; decision tracked in #64 |
| Dependabot / secret scanning | 0 | no open alerts |

Alert numbers reviewed: 181–190 (rate limiting), 178 (request forgery),
179 (zipslip), 180 (resource exhaustion), 131/133/134 (token permissions),
153–199 (pinned dependencies). Verdicts are in `FINDINGS.md` F-11…F-15.

## NOT TESTED (explicit)

| Area | Why | Consequence |
|---|---|---|
| Kata microVM isolation, guest→host | No disposable cluster; only `graphn-beta` is configured | Guest escape is **unverified**, not passed |
| Cilium NetworkPolicy, pod→pod, pod→API, metadata | Same | Network isolation is **unverified** |
| Trivy image scan | No image built/pushed in this review | Image CVE status unknown |
| Testnet / mainnet settlement | Requires real funds and a facilitator; forbidden | Only `mock:local` exercised |
| Multi-replica API/controller | SQLite single-writer; not a supported config | Concurrency across replicas untested |
| `TRUST_PROXY_HOPS > 0` behind a real proxy | Deployment-specific | XFF trust untested in situ |
| Long-running soak, fd/connection leaks | Time-boxed review | Only bounded deterministic tests |
| Refund worker (real mode) | Not implemented | F-10 open |
