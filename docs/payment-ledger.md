# Payment ledger and refunds

Status: durable ledger, terminal-refund policy, settlement reconciliation and
an opt-in refund worker are implemented. Mock payments refund automatically;
real payment modes leave an explicit `REFUND_PENDING` until an
operator-configured refund endpoint resolves it, or the attempts run out. Refund
execution is **effectively-once**: a durable claim plus a stable provider
idempotency key, not exactly-once. No partial refunds or customer credits yet.
**None of the real-money path has been executed against a real facilitator or a
real chain**: see [Limits](#limits).

The claim, key, lease, retry and outcome rules are the shared durable-call
contract in [ADR 0011](adr/0011-durable-external-calls.md) and
`shared/src/durable/`. This document is the ledger's application of it: the SQL,
the states, the policy and the operator surface.

## States

```text
SETTLED ──> REFUND_PENDING ──> REFUND_SENDING ──> REFUNDED
   └──────────────────────────> REFUNDED   (mock auto-refund or manual)
```

`REFUND_SENDING` is the worker's claim: the row is owned by one pass until the
provider answers or the claim lease expires. See
[Refund worker](#refund-worker) for the transitions out of it.

A ledger row is written in the **same database transaction** as the payment,
session and payment-intent settlement in `Store.completeEntitlement`. There is
never a session without a ledger row, or a ledger row without its entitlement.

| Field | Meaning |
|---|---|
| `payment_key` | x402 payment key; primary key |
| `session_id` | session that consumed the payment; unique |
| `payer`, `amount`, `asset`, `network`, `mode` | payment identity |
| `status` | `SETTLED`, `REFUND_PENDING`, `REFUND_SENDING`, `REFUNDED` |
| `reason` | why a refund was requested |
| `refund_tx` | mock transaction id or operator-supplied real transaction id |
| `settlement_nonce` | EIP-3009 authorisation nonce, so a refund can be keyed by it |
| `refund_attempts`, `refund_last_error`, `refund_next_attempt_at` | refund worker retry state |
| `refund_claim_token`, `refund_claimed_at` | owner and lease of the current `REFUND_SENDING` claim |
| `refund_idempotency_key` | stable provider key from `refundKey()`, `refund:<payment_key>` (schema v18) |

## Claim fencing and idempotent completion

`payment_intents` carries a `claim_token` and `claim_expires_at`, the grant
path's encoding of the same lease as the ledger's `refund_claim_token` and
`refund_claimed_at` ([ADR 0011](adr/0011-durable-external-calls.md)):

- The first claim inserts the intent as `claimed` and returns a fresh token.
- A live claim makes a second claim `in_progress`.
- A claim past its recorded lease, or older than the caller's `staleMs` (the
  crash path), is reclaimed with a **new** token. The previous owner is fenced
  out.
- `complete` must present the current token. The check happens inside the
  settlement transaction that writes the payment, ledger and session rows, so a
  stalled owner that was reclaimed cannot settle.
- Completion is idempotent: if the intent is already `settled`, the caller gets
  the winning `sessionId` and a successful response instead of an error. No
  second payment, ledger row or session is written. Settlement clears the claim
  token and its deadline.

The controller treats a mismatch as `409 stale_claim`. The API turns an
idempotent completion into the normal `200` session response for the same
capability.

The settle call itself is classified with the shared outcome algebra. A thrown
facilitator call, or a `settlement_pending` answer, is `unknown`: with a
settlement lookup configured the intent stays `claimed` so recovery can find it,
rather than being failed on an outcome that may have moved money. A plain
refusal still fails the intent and releases the capacity hold.

## Settlement recovery (settle-then-crash)

`payment_intents` records the payment requirements at claim time
(`requirements_json`). A controller housekeeping pass lists intents that have
been `claimed` for longer than `SETTLEMENT_RECOVERY_GRACE_MS` (default 5 min),
asks the facilitator's settlement lookup whether that payment key settled, and
if it did, writes a ledger row:

| Field | Value |
|---|---|
| `session_id` | `unsettled:<paymentKey>` (synthetic; no session exists) |
| `status` | `SETTLED`, then the refund policy below applies |
| `reason` | `settled_without_entitlement` |
| `payer`, `amount` | from the lookup |
| `asset`, `network` | from the requirements recorded at claim |

That closes F-10's worst case: the money moved, the client got a 402, and nothing
recorded the debt. The row is now visible in
`GET /internal/payments?status=REFUND_PENDING` and the `sandbox_refunds_pending`
gauge.

It deliberately does **not** create an entitlement: the spec, the client key and
the capability are gone by then, and inventing them would be worse than
refunding. It also leaves an *unsettled* intent alone, because the API still owns
the retry path and failing the intent here would race a slow settlement. While
that ledger row is `SETTLED` the fail endpoint refuses the intent too, so the
resolution is the refund policy below, not an outbox edit.

Recovery needs a facilitator that exposes `GET /settlements/:paymentKey`
(`FACILITATOR_URL`, the mock facilitator does). Without one it is a no-op, and
the `409 reconciliation_pending` behaviour is unchanged.

## Refund policy

A refund is considered when the session reaches a terminal state with
`ready_at = NULL`:

- provisioning failure, queue timeout, provisioning timeout,
- expiry before READY,
- client destroy before READY.

Once a session has reached READY, the ledger stays `SETTLED`; the customer
received service, and any exception is a manual review. There is one deliberate
exception: a session terminated by the relay-continuity branch as
`failure:relay_lost` is refunded in full even though it reached READY, because
the paid time after the loss was undeliverable. A client destroy or an ordinary
lease expiry after READY is not refunded.

`RefundService` is invoked after `finalizeTermination`:

- `mode = mock`: writes `REFUNDED` with a `mock:refund:...` transaction id.
- `mode = testnet` (or future real modes): writes `REFUND_PENDING`, with no
  fake on-chain transaction. The refund worker or an operator resolves it.

All transitions are conditional in SQL, so retries and repeated termination
paths cannot refund twice. Housekeeping also scans terminal-before-READY
sessions whose ledger is still `SETTLED`, terminal `relay_lost` sessions whose
ledger is still `SETTLED`, and settlement rows with no session (`unsettled:*`,
`duplicate:*`), repairing a crash between the write and the policy.

## Double charges

A `paymentKey` can never be redeemed twice (UNIQUE columns plus the facilitator
nonce). The remaining double-charge shape is **two different signed payments for
the same logical client**: the client key pair `(clientPublicKey, clientNonce)`
is generated fresh for every create by the SDK, so a repeat of that pair means
the same create was paid for twice (for example a retry that built a new payment
payload after a 402).

Policy: the second payment is recorded, refunded under the policy above with
reason `duplicate_client_nonce`, its intent is marked `failed`, and no second
session is created. The API answers `409 duplicate_session` with the existing
session id, and the client must not retry that payment. The ledger row uses a
synthetic session id `duplicate:<paymentKey>`, visible to the operator like any
other refund.

This cannot fire for a legitimate second session: a well-behaved client always
uses a fresh key pair. It *can* fire for a client that reuses a saved
`(clientPublicKey, clientNonce)` deliberately, which is exactly the case worth
stopping.

## Refund worker

`RefundWorker` runs in controller housekeeping, after settlement recovery:

| Env | Default | Meaning |
|---|---:|---|
| `REFUND_WEBHOOK_URL` | empty | operator endpoint that sends the funds; empty disables the worker |
| `REFUND_WEBHOOK_TOKEN` | empty | bearer token for that endpoint |
| `REFUND_MAX_ATTEMPTS` | `10` | stop after this many refused attempts |
| `REFUND_RETRY_BASE_MS` | `60000` | first retry delay, doubled per attempt (capped at 1 h) |
| `REFUND_CLAIM_LEASE_MS` | `60000` | how long one pass owns a claim; must exceed the webhook timeout |

The worker is one consumer of `shared/src/durable/`; the grant path is the other.
Nothing below redefines the protocol, it applies it:

| Piece | Refund worker | Grant path |
|---|---|---|
| key | `refundKey()` as `Idempotency-Key` and in the body | `settlementKey()` for log naming; the facilitator dedupes by nonce |
| lease | `refund_claimed_at` plus the worker lease, compared against `leaseCutoffMs` | absolute `claim_expires_at`, checked with `deadlinePassed` |
| fence | `refund_claim_token` in the completion and release `UPDATE` | `claim_token` in the settle `UPDATE` |
| retry | 10 attempts, 60 s base, 1 h ceiling, 60 s lease over a 10 s call | `staleMs` reclaim only |
| outcome | webhook status and thrown error | facilitator response and thrown call |
| `runClaimed` | the per-row loop | not used; the settlement transaction stays visible in the adapter |

### Claim before sending

A pass never sends a row it does not own. It claims up to `limit` due rows in one
statement:

```sql
WITH due AS (
  SELECT payment_key, status FROM payment_ledger
   WHERE refund_attempts < $max_attempts
     AND ( (status = 'REFUND_PENDING'
            AND (refund_next_attempt_at IS NULL OR refund_next_attempt_at <= $now))
        OR (status = 'REFUND_SENDING'
            AND (refund_claimed_at IS NULL OR refund_claimed_at <= $lease_cutoff)) )
   ORDER BY updated_at ASC LIMIT $limit
   FOR UPDATE SKIP LOCKED
)
UPDATE payment_ledger l
   SET status = 'REFUND_SENDING', refund_claim_token = $token,
       refund_claimed_at = $now,
       refund_idempotency_key = COALESCE(l.refund_idempotency_key,
                                         $key_prefix || l.payment_key),
       updated_at = $now
  FROM due WHERE l.payment_key = due.payment_key
RETURNING l.*, due.status AS previous_status;
```

The cutoff, the attempt limit and the key prefix all come from the worker
(`leaseCutoffMs`, the retry policy, `keyPrefix`): the statement compares
timestamps and never decides lease policy. `FOR UPDATE SKIP LOCKED` makes two
workers disjoint, so exactly one pass owns a row. `previous_status` tells the
worker whether it took the row from `REFUND_PENDING` or reclaimed an expired
`REFUND_SENDING` lease.

### State machine

| From | Event | To | Effect |
|---|---|---|---|
| `REFUND_PENDING` | claim, backoff elapsed | `REFUND_SENDING` | fresh token, lease, idempotency key |
| `REFUND_SENDING` | claim, lease expired | `REFUND_SENDING` | new token and lease, same key |
| `REFUND_SENDING` | provider paid | `REFUNDED` | `refund_tx`, only if the token matches |
| `REFUND_SENDING` | provider refused (4xx) | `REFUND_PENDING` | attempts + 1, backoff, token cleared |
| `REFUND_SENDING` | timeout, 5xx, no transaction | `REFUND_SENDING` | unchanged, retried when the lease expires |
| `REFUND_PENDING` | attempts at `REFUND_MAX_ATTEMPTS` | `REFUND_PENDING` | never claimed again, stays visible |
| `SETTLED` | mock refund or operator | `REFUNDED` | direct path, not the worker |
| `REFUNDED` | any | `REFUNDED` | terminal; the claim query cannot select it |

A refused attempt at the limit is terminal for the worker: the row stays
`REFUND_PENDING` with `refund_attempts` at the limit and `refund_last_error` set,
and shows up in the operator endpoint and the pending gauge. The manual refund
endpoint deliberately refuses `REFUND_SENDING`; that row belongs to a worker
that may be mid-send.

A restart needs no separate recovery: the claim query already treats an expired
`REFUND_SENDING` lease as due, and `RefundService.reconcile` repairs terminal
`relay_lost` rows still `SETTLED`. There is one send path.

### Provider contract and effectively-once

`POST $REFUND_WEBHOOK_URL` with
`{paymentKey, settlementNonce, payer, amount, asset, network, mode, reason, idempotencyKey}`
and `Idempotency-Key: refund:<paymentKey>`, expecting
`200 {"transaction":"<id>"}`. The endpoint holds the signing authority; this
process does not, so a compromised controller cannot move funds by itself.

**The provider must key on `Idempotency-Key`**, which is the provider half of the
guarantee in
[ADR 0011](adr/0011-durable-external-calls.md#what-is-not-guaranteed). The same
key returns the original transaction and moves no funds again. On this side the
guarantee is the durable claim, the fence and the classifier: an ambiguous answer
is `unknown` and retried with the same key, and a reclaimed owner records
nothing.

What it does not survive: a provider that ignores the key (two transfers), or a
row whose key is changed between attempts (do not do that). Exact-once across an
unreliable network is not achievable from this side.

Metrics: `sandbox_refunds_total{mode,result}` (policy outcomes),
`sandbox_refund_worker_total{result}` (`refunded`, `failed`, `unknown`,
`exhausted`, `reclaimed`, `claim_lost`), `sandbox_refunds_pending` and
`sandbox_refunds_sending` (gauges), `sandbox_settlement_recovery_total{result}`.
Logs carry a 12-character payment key prefix, never the full key; the
idempotency key contains the payment key, so it is not logged either.

## Ledger audit

Three paths move money: `completeEntitlement` writes the payment, ledger and
session in one transaction; the refund worker claims and sends; settlement
recovery writes a ledger row for a payment that settled without an entitlement.
Each path is guarded on its own, and nothing compared their results with each
other. A settled intent with no ledger row, or a ledger row that says service
was delivered for an intent that failed, was invisible until a human reconciled
a spreadsheet.

`controller/src/ledger-audit.ts` is that comparison. It is a pure function over a
snapshot. `controller/src/ledger-audit-sampler.ts` runs it on a timer
(`LEDGER_AUDIT_INTERVAL_MS`, default `300000`, accepted range is one second to
one hour), and the metrics scrape only renders the last sampled values and their
age. There is no transaction, no writer lock and no write. The two `SELECT`s run
one at a time on a dedicated connection opened with
`default_transaction_read_only=on` and a 2 s statement timeout, and the sampler
single-flights, so a slow database costs one audit connection and one sample
rather than a queue. A standby replica samples too, because reading is what it
is for. The families are registered by the first successful sample in the
controller role only, so a relay or proxy pod exports no uncollected zero.

What it checks:

| Metric sample | Meaning |
|---|---|
| `sandbox_ledger_divergence{reason="settled_without_ledger"}` | The intent is `settled`, the ledger has no row with that payment key. Money moved and the books did not keep it. |
| `sandbox_ledger_divergence{reason="intent_failed_ledger_settled"}` | The intent is `failed`, the ledger row is `SETTLED`. The outbox says refused, the books say delivered. The fail endpoint refuses this pair in the same statement as the status change, so no request writes it. A sample means a row was written outside the request path: a manual edit, a one-sided restore, or settlement recovery that crashed between writing its row and applying the refund policy. |
| `sandbox_ledger_divergence{reason="duplicate_refund_claim"}` | Two ledger rows in `REFUND_SENDING` share one settlement nonce, so one signed authorisation is being refunded twice. `payment_key` cannot repeat, the nonce is the identity that can. |
| `sandbox_sessions_stale{phase}` | A non-terminal session is past its deadline by more than the grace period. The deadline is `lease_expires_at` at READY, otherwise `created_at + max_lifetime_seconds` (protocol maximum when null). |
| `sandbox_ledger_audit_age_seconds` | Seconds since the last successful sample, recomputed from the clock on every scrape. It rises while samples fail or the timer is stopped, including after a good reading, so a stale sampler cannot look fresh. Absent until the first success. |
| `sandbox_ledger_audit_failures_total` | A sample could not read the snapshot. Until a sample succeeds the gauge families are absent, and after one succeeds a failure leaves the last good values in place, so a read failure never looks like a balanced ledger. |

Both reads are unbounded. The duplicate check is grouped in SQL over every
`REFUND_SENDING` row, so a backlog cannot hide a pair: the worse the stuck
claims, the larger the group it reports. Stale sessions are read unbounded as
well, because they are bounded by admission capacity rather than by history, and
their phase counts are exact. Intent divergences used to be capped at 500 rows.
That cap bounded the rows returned, not the scan, so it only made a large
incident look smaller than it was; it is gone now that the read is off the
scrape path. In a healthy ledger the predicate matches nothing, and when it does
match a lot the exact count is the number an operator needs. The stale check adds
60 seconds of slack, which keeps the reconciler's own decision latency out of the
signal.

The pass is a full scan of `payment_intents`, so its cost grows with the ledger:
about 25 ms at 100k intents and 1.3 s at 10M. At the five-minute default that is
1.3 s per sample instead of 1.3 s per 15 s scrape on every replica. Raise
`LEDGER_AUDIT_INTERVAL_MS` as the table grows; the age alert below is how you
notice the interval no longer fits.

It deliberately does not check:

- the chain, the facilitator or the refund provider. It reads this database, so
  a transfer made outside these three paths has no row here to compare;
- amounts, fees or net settlement. The ledger records the payment amount, and
  the intent's `requirements_json` is recorded at claim time, not proof of what
  moved;
- ledger rows with no intent. Every writer of the ledger starts from an intent
  row, so an orphan would be a manual edit; `GET /internal/payments` is the
  exhaustive view;
- an intent still `claimed`. Settlement recovery leaves it claimed after writing
  the ledger, which is the documented settle-then-crash shape;
- a refund the provider sent but the worker never recorded. The row stays
  `REFUND_SENDING` and the pending gauge is the signal, not a divergence.

Alert on:

```promql
# money moved with no ledger row (SandboxLedgerDivergence, critical)
sandbox_ledger_divergence{reason="settled_without_ledger"} > 0

# these two are always a bug, not a slow path (also SandboxLedgerDivergence):
# no request writes the first pair, so a row was changed outside it (edit,
# one-sided restore, or a recovery crash); the second is one authorisation
# being refunded twice
sandbox_ledger_divergence{reason="intent_failed_ledger_settled"} > 0
sandbox_ledger_divergence{reason="duplicate_refund_claim"} > 0

# cleanup that is not finishing, three or more sessions in one phase
# (SandboxSessionsStale; one long-lived session does not fire it)
max by (phase) (sandbox_sessions_stale) >= 3

# no successful sample for two default intervals (2 x 300 s, and the rule
# is two intervals, not 600 s, if LEDGER_AUDIT_INTERVAL_MS changes)
# (SandboxLedgerAuditStale)
sandbox_ledger_audit_age_seconds > 600

# the sampler has never completed a sample, so the families above are absent
# rather than zero (SandboxLedgerAuditNeverSampled)
absent(sandbox_ledger_audit_age_seconds)

# the audit is failing some reads but still succeeding enough to stay fresh
# (SandboxLedgerAuditFailing)
increase(sandbox_ledger_audit_failures_total[15m]) > 0
```

The rules live in
`deploy/monitoring/contract/rules/sandbox-slo.yaml` and are listed with their
`for:` windows in `deploy/monitoring/README.md#alerts`. If
`LEDGER_AUDIT_INTERVAL_MS` is raised, raise the age threshold with it: the rule
is two intervals, not 600 seconds.

A flagged key is looked up with
`GET /internal/payments/<paymentKey>`; the metric never carries a payment key or
a session id as a label.

## Operator endpoints

These are internal, protected by the controller admin token; they are not
exposed through the public API.

```bash
# ledger by payment key
curl -H "x-internal-token: $ADMIN" \
  http://controller:3001/internal/payments/<paymentKey>

# refunds awaiting resolution
curl -H "x-internal-token: $ADMIN" \
  "http://controller:3001/internal/payments?status=REFUND_PENDING"

# resolve a pending refund after sending funds
curl -X POST -H "x-internal-token: $ADMIN" -H "content-type: application/json" \
  -d '{"transaction":"0x…","reason":"manual_refund"}' \
  http://controller:3001/internal/payments/<paymentKey>/refund

# the same by EIP-3009 authorisation nonce, which is what a facilitator webhook
# knows; both forms of the refund endpoint accept either identifier
curl -H "x-internal-token: $ADMIN" \
  http://controller:3001/internal/payments/by-nonce/<0x…>

# fail an intent whose settlement was refused, so a client retry does not
# re-attempt the same payment key
curl -X POST -H "x-internal-token: $ADMIN" -H "content-type: application/json" \
  -d '{"reason":"settlement_failed"}' \
  http://controller:3001/internal/payment-intents/<paymentKey>/fail
```

The fail endpoint answers `409` with `{"error":"ledger_settled","ledgerStatus":"SETTLED"}`
when a `SETTLED` ledger row exists for that payment key, and changes nothing. The
ledger guard is part of the same `UPDATE` as the status change, so a settlement
committing at the same moment cannot be turned into a failed intent. That is
deliberate: `intent_failed_ledger_settled` is the alert that the books disagree,
and an operator action must not be able to raise it. The recovery for a payment
whose money moved is the refund endpoint above, not a retried fail, and there is
no force flag: if you believe you need one, the ledger row is wrong, not the
guard.

The manual endpoint refuses to refund a `SETTLED` ledger whose session reached
READY unless it is already `REFUND_PENDING`, and refuses a `REFUND_SENDING` row:
a worker owns that claim and may be mid-send.

## Limits

- **The real-money path has never run.** The reconciliation worker and the refund
  worker are exercised against stubs and the mock facilitator. No test in this
  repository has moved testnet funds, and `REFUND_WEBHOOK_URL` has no
  implementation in this repository.
- The refund endpoint protocol (`POST` with a `{transaction}` reply and
  `Idempotency-Key` dedupe) is a contract this repository defines, not one a
  facilitator provides. A real facilitator with a refund API needs an adapter,
  and effectively-once depends on that adapter honouring the key. A provider that
  ignores it can still be paid twice across a crash; the ledger cannot detect
  that.
- Recovery depends on a settlement lookup the facilitator must expose. Testnet's
  public facilitator does not, so testnet still answers `409
  reconciliation_pending` and the money is only visible to a human who reconciles
  the on-chain transfer.
- An ambiguous refund outcome (timeout, 5xx, no transaction id) is `unknown`, not
  a failed attempt: the row stays `REFUND_SENDING` and is retried each time its
  lease expires, with the same key, indefinitely. `REFUND_MAX_ATTEMPTS` bounds
  definite refusals only. That is the shared rule, not a refund exception; see
  [ADR 0011](adr/0011-durable-external-calls.md#what-is-not-guaranteed). Giving up
  on a payment that may have moved is worse than a visible
  `sandbox_refunds_sending` gauge that stays above zero; an operator still has to
  reconcile that row.
- The claim lease bounds duplicate sends only against a *slow* pass. A pass whose
  provider call outlives `REFUND_CLAIM_LEASE_MS` is safe only because the resend
  reuses the key, not because the lease prevented it.
- No partial refunds, prorating, credits, or a per-payer spend ledger beyond the
  admission budget ([admission-control.md](admission-control.md)).
- The ledger records the payment amount, not fees or net settlement.
- A refund that exhausts its attempts is not escalated: an operator has to find
  it in the pending list and act.
