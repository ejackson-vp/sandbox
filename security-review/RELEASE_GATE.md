# Release gate

Four deployment profiles are gated separately. "Unverified" is not "passed".

**Provenance.** This gate is a code-and-process assessment written by the same
assistant that wrote most of the code under review. It is not an independent
reviewer and not a penetration test. Where a row depends on an executed run, the
row cites it; where it depends on reading code and tests, it says so.

## Gate checklist

| Control | Status | Evidence |
|---|---|---|
| Payment replay cannot mint a second entitlement | PASS | F-02 integration tests |
| Receipt holder cannot bind another client key | PASS | F-02 integration tests |
| Capability is bound to the client commitment | PASS | F-02, `capabilityFor(key, commitment)` |
| A captured create request is not a permanent replay | PASS | F-07, challenge nonce (#47) |
| Exactly-once ledger under crash/retry (mock) | PASS | crash-recovery test, `countPayments` |
| Unknown-database downgrade / destructive upgrade | PASS | F-03 migration tests, additive ladder to v19 |
| Custom price ≠ admitted limit divergence | PASS | property test, controller re-resolution |
| Egress per-session and global **connection** budgets | PASS | F-01, 32-way concurrency test |
| Egress per-session and global **byte** budgets | PASS | `tests/unit/egress-budget.test.ts`; alert rules and a scrape target exist (`deploy/monitoring`) |
| Egress destination validation (SSRF matrix) | PASS | 24-case suite |
| API concurrent connections per client | PASS | `tests/unit/connection-limit.test.ts` |
| Rate-limit penalties survive high cardinality | PASS | F-05 |
| Image published only after a passing scan | PASS | staged tag, scan by digest, promote after both scans |
| Actions and base images pinned | PASS | every `uses:` is a SHA, every `FROM` is `@sha256:`; `check-deploy-pins.mjs` |
| Guest pod image pinned at admission | PASS | Kyverno policy fixed and executed: `scripts/kyverno-policy-test.sh` green on kind 1.32.2 with Kyverno 1.13.4, six admission outcomes |
| Runtime class cannot silently degrade | PASS | startup read of the RuntimeClass, non-microVM handler refuses to serve; fake-apiserver tests. Guard applies when `EXECUTION_MODE=kata` (F-18) |
| Least-privilege workflow tokens | PASS | job-scoped `permissions`, `contents: read` default |
| Cilium pod→pod / pod→API / metadata isolation | PASS (Cilium) | packet-level suite green per pull request, plus the anonymous attacker suite |
| Kata guest→host isolation | **PASS** for the tested digests | `docs/isolation-evidence.md`: network 4/4, workload 10/10, warm pool 3/3 on a Talos cluster with handler `kata`, guest kernel 6.18.35 against host 6.18.51. Control `0.1.33` `sha256:4804da2e…`, guest `0.1.33` `sha256:933a53e0…`, 23 passed and 1 skipped on the deployed pair. Proves the boundary properties the suite tests. No escape attempt was made and there is no hardware root of trust |
| Real-mode settled-but-not-provisioned recovery | PASS (chain path) | The controller's recovery worker proves the transfer from the recorded authorizer, nonce and terms (schema v20, ADR 0014), so debt is written without a client retry. The facilitator lookup remains a fallback for networks with no chain read. Unproven with real funds: no settle has executed |
| Real-mode refunds executed | PARTIAL | worker and webhook contract, mock-tested only; never moved funds |
| Chain verdict binds amount and recipient | PASS | F-17 fixed: the verifier reads the nonce's transaction and requires a `Transfer` from the authorizer to `PAY_TO` for at least the price. Residual is the bounded scan window (90,000 blocks), not the trust assumption |
| Free entitlement cannot be obtained by a non-allowlisted payer | PASS | F-20: check runs after commitment proof, on the proven signer; 100% mutation score |
| Allowlisted payer cannot exhaust a paid payer's budget | PASS | separate `allow:<address>` budget namespace |
| Mainnet cannot activate silently | PASS | startup assertions: explicit `NETWORK`, real `PAY_TO`, `FACILITATOR_URL`, on-chain verifier |
| Facilitator credentials never travel in plaintext | PASS | `FACILITATOR_API_KEY_*` requires an `https://` URL at startup |
| Capacity quotas per payer/IP | PASS | durable per-payer and global budget (#48) |
| Budget survives a controller restart | PASS | `tests/unit/payer-budget.test.ts` |
| Multi-replica controller | SUPPORTED (writer-safe) | Postgres, Kubernetes Lease, writer guard, measured handover. The store is still a single primary (ADR 0010) |
| Postgres durability | PARTIAL | daily logical backups complete in the reference deployment. PITR is designed and drilled locally (ADR 0015, `make pitr-drill`) but not provisioned: no bucket, no `postgres-pitr` Secret, so nothing archives today. The restore drill exists and has not run on production data (#162) |
| Alerts reach a human | **FAIL** | the rule file ships no receiver; the reference stack evaluates with `-notifier.blackhole` |
| Incident procedures rehearsed | **FAIL** | four runbooks and a tabletop script, none executed (#60) |
| Emergency stop | PARTIAL | durable create kill switch (schema v21): `sandbox admin killswitch enable` writes one row the API reads before any payment or capacity work, refusing `503 creates_disabled` while live sessions keep executing. Proven by `tests/unit/create-switch.test.ts` (refusal order, fail-closed read, live exec while on), `create-switch-store.test.ts`, `create-switch-admin.test.ts` and `create-switch-migration.test.ts`. Not exercised against a production incident, and the API must be deployed after the controller (a new API with an old controller fails closed) |
| Independent test of the guest/host boundary | **FAIL** | not performed |

---

## 1. Local development — **READY**

Profile: `make up`, `PAYMENT_MODE=mock`, `runc`, single operator, no untrusted
users, no real money.

**Verdict: READY.** Build, typecheck, 1331 unit, 162 property, 78 integration,
40 portable and the Go suite pass. The original conditions still hold: do not
expose the API or the proxy, treat `mock:local` as having no economic security,
and expect a capability minted before an upgrade to stop verifying (F-08).

## 2. Trusted private beta — **CONDITIONAL**

Profile: known users or internal agents, mock payments or pre-funded credit,
operator reachable, guests run code you would tolerate on a shared node.

**Verdict: CONDITIONAL.** Conditions:

1. Deploy images by digest. The pins now exist and CI fails on drift, so this is
   a deployment check rather than a hope.
2. Keep `TRUST_PROXY_HOPS=0` unless a proxy you control overwrites
   `X-Forwarded-For` (F-09).
3. Accept that Kata is unverified here and say so to the tenant.
4. A human reconciles and executes `REFUND_PENDING` if real settlement is used: the debt is recorded automatically now, but the refund worker only sends through an operator-configured webhook, and it has never moved funds (F-10).
5. Accept the F-07 residual: a capture of the live challenge *and* its signed
   request, replayed first, is equivalent to the client.

## 3. Public beta with payment enforcement — **BLOCKED**

Profile: anonymous internet users, real settlement, money moves automatically.

**Verdict: BLOCKED.** Five blockers, in order:

1. **Kata is unverified.** Cilium is proven per pull request; the VM boundary has
   never run on KVM hardware. A public beta that runs hostile code cannot claim
   isolation from unit tests.
2. **No real settlement has executed.** One settle and one refund must move funds
   and appear in the ledger before the copy on the site is true.
3. **Nothing pages.** Alerts evaluate into a blackhole. A payment incident would
   be discovered by a customer.
4. **Incident response is written, not rehearsed.**
5. **No kill switch.** The only emergency stop also stops reads for live sessions.

Closed since the last gate: image promotion order (F-06), action and base-image
pinning (F-15), the Kyverno policy being invalid rather than merely unexecuted,
the SQLite single-writer limit, and the missing egress byte budget.

## 4. Unrestricted hostile multi-tenant production — **BLOCKED**

Profile: arbitrary internet tenants, real money, untrusted code, an SLA.

**Verdict: BLOCKED.** All public-beta blockers, plus:

- **No independent test of the guest/host boundary.** This review is by the
  author of the code.
- **No provisioned PITR and no measured database failover.** The store is one
  Postgres primary; backups are daily and logical. The PITR design is shipped and
  drilled locally (ADR 0015) with no object store behind it yet (#162).
- **Checkpoints are plaintext and node-pinned** (ADR 0007). Any product that
  sells suspendable sessions inherits that.
- **Relay state is in process memory**, so a restart still costs one interrupted
  operation per session even though the session survives (#24).
- **The capability is a bearer token for its TTL** (F-07). No per-request proof
  of possession.
- **Key custody is a Kubernetes Secret.** Rotation by key id is implemented;
  there is no KMS or HSM.

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
| Kata isolation | A release run whose `isolation` job is green on a KVM-capable runner, with `tested-images.json` naming the same control and guest digests that `promote` tagged. `make security-isolation` against a real Kata cluster is acceptable for a one-off, and does not replace the per-tag run |
| Real money | One settle and one refund on a mainnet-equivalent network, with the ledger rows and the transaction hashes recorded |
| Paging | One alert delivered to a person through the configured receiver, and the runbook step it triggered written down |
| Kill switch | A create refused with `503` while an existing session keeps executing, demonstrated and tested |
| Incident response | A recorded tabletop with a gap list that has owners and dates (#60) |
| F-19 | A settled-but-unentitled payment reconciled by the controller with no client retry |
| F-17 | The ordering test stays green: a chain-settled nonce with a failed verify grants nothing |

## Appendix — point-in-time security assessment

Recorded against `5d4d50a` plus the delta review. Code-and-process, not an
independent test.

| Profile | Rating | Binding constraint |
|---|---|---|
| Local development / trusted private beta | **8 / 10** | Bearer capability within its TTL; dev attestation is insecure by design |
| Public beta with payment enforcement | **6 / 10 — blocked** | Kata unverified, no paging, real money unexecuted |
| Unrestricted hostile multi-tenant | **4 / 10 — blocked** | No independent boundary test, no PITR, plaintext checkpoints |

Dimension grades: design **A-**, audited code paths **B+** (the delta review
covered the new trust surfaces), verification **B** (Cilium and the attacker
suite run; Kata does not), supply chain **A-** (SHA and digest pins enforced in
CI, provenance attested, promotion gated), operations **D** (nothing pages, no
kill switch, no rehearsal, single primary database).

Confidence: medium-high on the paths covered by tests and by executed CI;
low on every isolation claim that depends on Kata, and low on anything that
depends on money actually moving, because it has not.

The three changes that would move public-beta readiness most:

1. Run the Kata suite on KVM hardware and record the digests (#44).
2. Wire one alert to a human and add the kill switch.
3. Execute one real settle and one real refund.
