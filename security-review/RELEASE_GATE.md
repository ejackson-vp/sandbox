# Release gate

Four deployment profiles are gated separately. "Unverified" is not "passed".

## Gate checklist

| Control | Status | Evidence |
|---|---|---|
| Payment replay cannot mint a second entitlement | PASS | F-02 integration tests |
| Receipt holder cannot bind another client key | PASS | F-02 integration tests |
| Capability is bound to the client commitment | PASS | F-02, `capabilityFor(key, commitment)` |
| Exactly-once ledger under crash/retry (mock) | PASS | crash-recovery test, `countPayments` |
| Unknown-database downgrade / destructive upgrade | PASS | F-03 migration tests |
| Custom price ≠ admitted limit divergence | PASS | property test, controller re-resolution |
| Egress per-session and global budgets | PASS | F-01, 32-way concurrency test |
| Egress destination validation (SSRF matrix) | PASS | 24-case suite |
| Rate-limit penalties survive high cardinality | PASS | F-05 |
| Image published only after a passing scan | **FAIL** | F-06 |
| Real-mode settled-but-not-provisioned reconciliation | **FAIL** | F-10 |
| Real-mode refunds executed | **FAIL** | F-10 (`REFUND_PENDING`, no worker) |
| Actions/images pinned by digest | **FAIL** | F-15 |
| Least-privilege workflow tokens | **FAIL** | 3 `TokenPermissionsID` alerts |
| Kata guest→host isolation | **UNVERIFIED** | not executed |
| Cilium pod→pod / pod→API / metadata isolation | **UNVERIFIED** | not executed |
| Image vulnerability status | **UNVERIFIED** | no image built |
| Multi-replica controller | NOT SUPPORTED | SQLite single-writer |
| Capacity quotas per payer/IP | PARTIAL | admission exists; no durable per-payer budget |

---

## 1. Local development — **READY**

Profile: `make up` / local processes, `PAYMENT_MODE=mock`, `runc` or local
`LocalProvisioner`, single operator, no untrusted users, no real money.

**Verdict: READY.** All offline suites pass (227 tests). The fixed issues remove
the paths that would let one local session exhaust the proxy, replay a mock
receipt, or lose the local ledger on a schema bump.

Conditions:

- Do not expose the API or egress proxy to the internet.
- Treat `mock:local` as having no economic security (it does not).
- Expect sessions created before the upgrade to lose their capability (F-08).

## 2. Trusted private beta — **CONDITIONAL**

Profile: a small set of known users or internal agents, mock payments **or**
pre-funded credit (no automatic real settlement), single replica, operator
reachable, guests run code you would tolerate on a shared VM.

**Verdict: CONDITIONAL — approved only with every condition below.**

1. Deploy images by **digest**, never by tag, until F-06 is fixed.
2. If real settlement is used at all, a human must reconcile
   `REFUND_PENDING` / failed-intent cases manually (F-10 runbook), and the beta
   must cap exposure per user.
3. Keep `TRUST_PROXY_HOPS=0` unless a proxy you control overwrites
   `X-Forwarded-For` (F-09).
4. Run single-replica API/controller; do not scale the controller.
5. Accept that a full create-request capture is equivalent to the client (F-07).
6. Onboard only tenants for whom `runc`-class isolation is acceptable; Kata is
   unverified here.

## 3. Public beta with payment enforcement — **BLOCKED**

Profile: anonymous internet users, real (testnet or mainnet-equivalent)
settlement, money changes hands automatically.

**Verdict: BLOCKED.** Blockers, in order:

1. **F-06** — a failed scan still leaves a pullable version/latest tag.
2. **F-10** — a crash between settlement and entitlement loses the payment in
   testnet mode (no lookup, no refund). Real refunds are never executed.
3. **F-15 / TokenPermissions** — release and CodeQL workflows are not pinned or
   least-privilege; CI supply chain is not gated.
4. **Kata and Cilium are UNVERIFIED.** A public beta that runs hostile code
   cannot claim tenant isolation from `runc` or from unit tests.
5. No durable per-payer capacity/abuse budget; only in-memory token buckets.
6. **Incident response: written, not rehearsed.** Three runbooks and a tabletop
   script exist under `docs/runbooks/`. No exercise has been run, so the
   procedures are unverified and the gaps they will find are unknown
   ([tabletop.md](../docs/runbooks/tabletop.md)).

## 4. Unrestricted hostile multi-tenant production — **BLOCKED**

Profile: arbitrary internet tenants, real money, untrusted code, SLA.

**Verdict: BLOCKED.** All public-beta blockers, plus:

- No verified microVM isolation or packet-level network attestation in CI. The
  release gate must run the Kata/Cilium suites on a disposable cluster and record
  the digest of the tested images.
- Control plane is a single-writer SQLite database with no HA, backup/PITR
  automation, or cross-region story.
- Capability remains a bearer token for its TTL (F-07); no per-request
  proof-of-possession.
- No KMS/HSM for `CAPABILITY_SECRET` / `CONTROLLER_ADMIN_TOKEN` rotation. Key ids
  plus a previous-key verify set make a manual rotation safe without draining
  sessions ([docs/runbooks/secret-rotation.md](../docs/runbooks/secret-rotation.md));
  custody is still a Kubernetes Secret.
- No per-tenant spend caps, anomaly detection, or abuse escalation path.
- No independent penetration test of the guest/host boundary.

## OpenSSF process decisions (proposed, not decided)

Two Scorecard alerts are maintainer decisions, not code changes
(#99). This section is the proposed wording so the decision is recorded in one
place. Nothing here is in force until it is agreed and the alerts are handled.

Proposed: **register the project for the OpenSSF Best Practices Passing badge**,
and keep the answers auditable by linking the badge entry from the README.

> **OpenSSF Best Practices badge — decision.** The project targets the
> **Passing** badge only. Several criteria already hold and can be checked in this
> repository: `SECURITY.md` (vulnerability reporting), a committed lockfile for
> every dependency, fuzzing targets and their corpora documented in
> [CONTRIBUTING.md](../CONTRIBUTING.md), and a test gate on every pull request.
> Where a criterion is not met, the answer says so rather than arguing the point;
> F-06, F-10 and F-15 in [FINDINGS.md](FINDINGS.md) are the three that this gate
> already knows about. Silver is out of scope because it requires a reviewer who
> is not the author, and this repository has one maintainer. The badge entry is
> the record of the answers, linked from `README.md` so a reader can audit a claim
> against the criterion it scores. A `CII-Best-Practices` score below 5 is not a
> blocker for the private beta and is not a substitute for any control here.

Proposed: **record the solo-maintainer exception** rather than requiring an
approval that no second person can give.

> **Code review — decision.** `main` does not require an approving review,
> because there is one collaborator and Scorecard does not count bot or
> AI-generated approvals. Requiring an approval would either block every merge or
> be satisfied by a bot, and the second outcome makes the metric lie. What
> compensates for the missing second reader is written down, not implied: every
> change arrives as a pull request whose description says what was verified; the
> required checks (`unit`, `integration (local guest)`, `markdownlint`,
> `internal links`) gate the merge; `codeql` analyses the branch head and `main`;
> a change to a trust boundary, a durability guarantee or a deployment constraint
> needs an ADR and a note in [FINDINGS.md](FINDINGS.md); and the release gate is
> gated on `make verify`. This exception is reviewed if a second maintainer is
> added, at which point one approval is required and administrators are included
> in the rule. It does not claim a control the repository does not enforce.

Do not close either alert by configuration alone. If the badge is not
registered, dismiss `CIIBestPracticesID` as "won't fix" with a pointer here
rather than leaving it undecided.

---

## Exit criteria for re-gating

| Blocker | Evidence required |
|---|---|
| F-06 | A release run where the version/latest tags appear only after Trivy passes; a deliberately failing scan produces no deployable tag |
| F-10 | End-to-end test in a non-production settlement sandbox: crash after settle → retry returns the entitlement or a refund is executed; ledger auditable |
| F-15 | Actions pinned to SHAs, images by digest, job-scoped `permissions` |
| Kata/Cilium | `make security-test` on a disposable kind/Cilium cluster **and** the real Kata class, with image digests recorded |
| Abuse | Durable per-payer quota with a test that survives a restart |

## Appendix — point-in-time security assessment

Recorded after `dd44e93`, so the rating has the same provenance as the findings.
This is a code-and-process assessment, not an independent penetration test.

| Profile | Rating | Binding constraint |
|---|---|---|
| Local development / trusted private beta | **8 / 10** | Bearer capability within its TTL; dev attestation is insecure by design |
| Public beta with payment enforcement | **4 / 10 — blocked** | F-10, F-06, unverified isolation |
| Unrestricted hostile multi-tenant | **3 / 10 — blocked** | Kata/Cilium unexecuted, no HA ledger, no durable quotas |

Dimension grades: design **A-**, audited code paths **B+**, verification **B-**
(the isolation suites are unexecuted), supply chain **B** (pins landed; release
promotion open), operations **C** (single-writer, no KMS rotation, no refunds).

Confidence: medium-high on the paths covered by tests; low on every isolation
claim, because no cluster was available.

The three changes that would move public-beta readiness most:

1. Execute the Kata and Cilium suites in a trusted release gate (#44).
2. Close the release-promotion and settlement-refund gaps (#42, #31).
3. Add durable per-payer quotas and a freshness nonce / per-request proof of
   possession (#48, #47).
