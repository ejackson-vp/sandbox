# Runbook: stuck real-mode refund

Use when a refund for a real payment mode has not cleared: alert
`SandboxRefundBacklog` (10 minutes), `SandboxRefundStuck` (2 hours),
`SandboxRefundSendingStuck` (1 hour), `SandboxRefundExhausted`, or a customer
saying they paid and got nothing. The symptom is always the same: `SETTLED`
money became `REFUND_PENDING`, and no transfer has come back.

This runbook is about the transfer. The policy that decides *whether* a payment
is refundable is
[payment-ledger.md](../payment-ledger.md#refund-policy), and mock payments never
get here: `mode = 'mock'` is refunded inline and is never `REFUND_PENDING`.

## What exists and who owns it

| Status (`payment_ledger.status`) | Means | Owner |
| --- | --- | --- |
| `SETTLED` | money moved and was delivered, or the debt was recorded and the policy has not run yet | controller |
| `REFUND_PENDING` | owed, not sent; either waiting for the next backoff or never claimed | refund worker |
| `REFUND_SENDING` | one pass claimed the row and may be mid-send; the outcome is not recorded | refund worker, until the claim lease expires |
| `REFUNDED` | terminal, `refund_tx` holds the provider transaction | nobody |

The status values are `LedgerStatus` in `controller/src/store/models/money.ts`.
The worker is `RefundWorker` in `controller/src/refund-worker.ts`; it runs in the
controller's housekeeping pass, after settlement recovery, and it is the only
component that sends a refund automatically.

What it does with one row:

1. Claims due rows in one statement, writing `refund_claim_token`,
   `refund_claimed_at` and `refund_idempotency_key = 'refund:<payment_key>'`.
2. `POST $REFUND_WEBHOOK_URL` with that key in an `Idempotency-Key` header and in
   the body, expecting `200 {"transaction":"<id>"}`.
3. Records the transaction, or counts the refusal and backs off, or leaves the
   row `REFUND_SENDING` when the answer was ambiguous.

An empty `REFUND_WEBHOOK_URL` disables the worker: it still publishes the
gauges, then returns without sending anything. The reference deployment ships it
commented out in `deploy/kubernetes/03-config.yaml`, so on a stock install
**every real-mode refund is a manual job**. Check that before anything else.

## Detect

| Signal | Where | Means |
| --- | --- | --- |
| `sandbox_refunds_pending` | controller metrics | rows in `REFUND_PENDING`; a customer waiting |
| `sandbox_refunds_sending` | controller metrics | rows claimed or awaiting reconciliation; not counted in the pending gauge |
| `sandbox_refund_worker_total{result}` | controller metrics | `refunded`, `failed`, `unknown`, `exhausted`, `reclaimed`, `claim_lost` |
| `sandbox_refunds_total{mode,result}` | controller metrics | the policy: `pending` is a row created for the worker, `refunded` is a resolved one |
| `SandboxRefundBacklog`, `SandboxRefundStuck` | vmalert | the pending gauge, at 10 minutes and 2 hours |
| `SandboxRefundSendingStuck` | vmalert | the pending gauge cannot see a row stuck in `REFUND_SENDING` |
| `SandboxRefundExhausted` | vmalert | a row hit `REFUND_MAX_ATTEMPTS` and will never be retried |
| `SandboxRefundWorkerSilent` | vmalert | the gauge family is absent, so every rule above is blind |

The rules live in the deployment repository at
`apps/sandbox-monitoring/vmalert-rules-refund.yaml`, not in this repo's
`deploy/monitoring/contract/`. They deliver through the same single Alertmanager
route as the SLO rules.

Two readings before the SQL, because they change the meaning of every row:

```bash
kubectl -n sandbox-system get configmap control-config \
  -o jsonpath='REFUND_WEBHOOK_URL={.data.REFUND_WEBHOOK_URL}{"\n"}REFUND_MAX_ATTEMPTS={.data.REFUND_MAX_ATTEMPTS}{"\n"}REFUND_RETRY_BASE_MS={.data.REFUND_RETRY_BASE_MS}{"\n"}'
```

`REFUND_WEBHOOK_URL` empty means nothing will ever send. `REFUND_MAX_ATTEMPTS`
defaults to 10 and `REFUND_RETRY_BASE_MS` to 60000; the claim lease,
`REFUND_CLAIM_LEASE_MS`, defaults to 60 s and is usually not set in the
ConfigMap.

The rows. Timestamps are epoch milliseconds (`BIGINT`), so every time column has
to be divided before `to_timestamp`:

```sql
SELECT payment_key,
       session_id,
       status,
       mode,
       amount,
       asset,
       network,
       source,
       refund_attempts,
       refund_last_error,
       COALESCE(refund_idempotency_key, 'refund:' || payment_key) AS idempotency_key,
       to_timestamp(created_at / 1000.0)             AS created_at,
       to_timestamp(updated_at / 1000.0)             AS updated_at,
       to_timestamp(refund_next_attempt_at / 1000.0) AS next_attempt_at,
       to_timestamp(refund_claimed_at / 1000.0)      AS claimed_at,
       date_trunc('second', now() - to_timestamp(updated_at / 1000.0)) AS idle_for
  FROM payment_ledger
 WHERE status IN ('REFUND_PENDING', 'REFUND_SENDING')
 ORDER BY updated_at ASC;
```

Run it against the database with:

```bash
kubectl -n sandbox-system exec -c postgres postgres-0 -- \
  psql -U sandbox -d sandbox -c "<the query above>"
```

The predicate is the one the `payment_ledger_refund_due` partial index is built on, and
`ORDER BY updated_at ASC` is the order the worker claims in, so the first row is
the one that has waited longest. `date_trunc` on a `NULL` (a row that lost its
timestamp) returns `NULL`, not an error.

The one-row form, by payment key or by the EIP-3009 authorisation nonce:

```sql
SELECT * FROM payment_ledger WHERE payment_key = '<payment_key>';
SELECT * FROM payment_ledger WHERE settlement_nonce = '<0x nonce>';
```

And the counts, to know how big the incident is before reading rows:

```sql
SELECT status, count(*) AS rows, to_timestamp(min(created_at) / 1000.0) AS oldest
  FROM payment_ledger
 GROUP BY status
 ORDER BY status;
```

## Triage

Read the row, not the gauge: `refund_attempts` and `refund_next_attempt_at` are
the two columns that separate "the worker is trying" from "the worker has
stopped".

| Row looks like | Meaning | Do |
| --- | --- | --- |
| `REFUND_PENDING`, `refund_attempts < REFUND_MAX_ATTEMPTS`, `next_attempt_at` in the future | a definite refusal, backing off. The worker is fine and the provider said no | nothing. Wait for the backoff. Read `refund_last_error` |
| `REFUND_PENDING`, `refund_attempts >= REFUND_MAX_ATTEMPTS` | exhausted. The claim query only selects `refund_attempts < REFUND_MAX_ATTEMPTS`, so this row is never picked up again | manual refund ([Recover](#recover)) |
| `REFUND_PENDING`, attempts below the limit, `next_attempt_at` `NULL` or in the past, `idle_for` minutes and growing | nobody is claiming it: the webhook is disabled, the controller is not the leader, or `housekeeping()` is failing before the refund worker | fix the sender ([Recover](#recover) if it cannot be fixed quickly) |
| `REFUND_SENDING`, `claimed_at` older than two leases (over 120 s with the default) and `idle_for` still growing | the claim expired and no pass reclaimed it. Same causes as the row above, one step further on | fix the sender; do not touch the row |
| `REFUND_SENDING`, `claimed_at` refreshed on every read | the worker is reclaiming it every lease and every send is coming back `unknown` (timeout, 5xx, or a 200 with no transaction id). It will never count an attempt and never give up | find out whether the provider already paid, with `refund:<payment_key>` |
| `refund_last_error` set, attempts below the limit | the provider refused with a message. That text is the whole diagnosis | fix or escalate with the provider |
| `source != 'x402'` | an allowlist row. A $0 row is never a refund candidate, so it should not be here at all | confirm it is $0 and leave it |

The `mode` column is worth a look on any row: `mock` rows are refunded inline by
`RefundService.applyPolicy`, so a `mock` row in `REFUND_PENDING` was written by
hand and is not a customer waiting.

Log lines, which is where the reason lives. The controller logs JSON:

```bash
kubectl -n sandbox-system logs deploy/controller --since=6h \
  | jq -r 'select(.msg|test("payment_refund|housekeeping_failed")) | [.ts, .msg, (.paymentKeyPrefix // "-"), (.attempts // "-"), (.error // "-")] | @tsv'
```

| Message | Means |
| --- | --- |
| `payment_refund_pending` | the policy created the row; the customer is owed |
| `payment_refund_attempt_failed` | definite refusal, attempt counted, backoff armed |
| `payment_refund_exhausted` | the row reached the attempt limit; this is the log form of `SandboxRefundExhausted` |
| `payment_refund_outcome_unknown` | ambiguous answer; the row stays `REFUND_SENDING` and the lease retries it |
| `payment_refund_record_failed` | the provider paid and the database write failed; also stays `REFUND_SENDING` |
| `payment_refund_reclaimed` | a second pass took the row after a lease expired |
| `payment_refund_lease_below_timeout` | `REFUND_CLAIM_LEASE_MS` is shorter than the 10 s webhook timeout; safe but noisy |
| `housekeeping_failed` | an earlier step in the same pass threw, so the refund worker did not run at all |

## Recover

The order is fixed: **funds first, record second**. The endpoint will happily
write `REFUNDED` for a transaction that does not exist, and nothing verifies it.

### 1. Capture the row and the key

```sql
SELECT payment_key, amount, asset, network, mode, payer, settlement_nonce,
       refund_attempts, refund_last_error, reason,
       COALESCE(refund_idempotency_key, 'refund:' || payment_key) AS idempotency_key
  FROM payment_ledger WHERE payment_key = '<payment_key>';
```

Copy `reason` into the ticket now: the record step below overwrites it. Then:

```bash
PAYMENT_KEY=<the payment key>
IDEMPOTENCY_KEY="refund:$PAYMENT_KEY"
AMOUNT=<amount from the row>          # atomic units, a decimal string
ASSET=<asset>
NETWORK=<network>
MODE=<mode>
PAYER=<payer, or null>
NONCE=<settlement_nonce, or null>
TICKET=OPS-<n>
```

`refund:<payment_key>` is not a convention invented here. It is
`refundKey()` in `shared/src/durable/keys.ts`, the key the worker would send and
the key stored in `refund_idempotency_key` the first time the row was claimed.

### 2. Send the funds with that key

Send to the same endpoint the worker uses, with the same body and header. Any
other path has to offer an idempotency field, and you put `refund:<payment_key>`
in it. The endpoint and its token are what the controller was configured with:

```bash
REFUND_WEBHOOK_URL=$(kubectl -n sandbox-system get configmap control-config \
  -o jsonpath='{.data.REFUND_WEBHOOK_URL}')
REFUND_WEBHOOK_TOKEN=<from the same ConfigMap or the controller Secret, if one is set>
```

If no token is configured, drop the `authorization` header: the executor only
sends it when `REFUND_WEBHOOK_TOKEN` is non-empty.

```bash
curl -sS -X POST "$REFUND_WEBHOOK_URL" \
  -H 'content-type: application/json' \
  -H "idempotency-key: $IDEMPOTENCY_KEY" \
  -H "authorization: Bearer $REFUND_WEBHOOK_TOKEN" \
  -d "{
        \"paymentKey\": \"$PAYMENT_KEY\",
        \"settlementNonce\": \"$NONCE\",
        \"payer\": \"$PAYER\",
        \"amount\": \"$AMOUNT\",
        \"asset\": \"$ASSET\",
        \"network\": \"$NETWORK\",
        \"mode\": \"$MODE\",
        \"reason\": \"manual_refund:$TICKET\",
        \"idempotencyKey\": \"$IDEMPOTENCY_KEY\"
      }"
```

`amount` is the ledger's decimal string in atomic units, not a human amount. Use
`null` for a `NULL` nonce or payer: both are nullable in `RefundRequest`
(`controller/src/refund-executor.ts`). A `200` with a `transaction` id is the
only success shape; a 4xx is a refusal and nothing moved; a 5xx, a timeout or a
200 with no transaction id is ambiguous and **nothing may be recorded**.

If the answer was ambiguous, stop here and read the provider's records for
`refund:<payment_key>` before doing anything else. The next attempt, yours or
the worker's, carries the same key, and the provider contract is that the same
key returns the original transaction instead of paying again.

### 3. Record the transaction

`TRANSACTION` is the `transaction` field from the response above. If that
response was lost or timed out, read the provider's record for
`refund:<payment_key>` and use that transaction; do not invent one.

```bash
TRANSACTION=<transaction from the send>
ADMIN=$(kubectl -n sandbox-system get secret x402-secrets \
  -o jsonpath='{.data.admin-token}' | base64 -d)
kubectl -n sandbox-system port-forward deploy/controller 13001:3001 &
curl -sS -X POST -H "x-internal-token: $ADMIN" -H 'content-type: application/json' \
  -d "{\"transaction\":\"$TRANSACTION\",\"reason\":\"manual_refund:$TICKET\"}" \
  "http://127.0.0.1:13001/internal/payments/$PAYMENT_KEY"
```

Expected `{"ok":true,"changed":true,...}` with the row now `REFUNDED` and
`refund_tx` set. Read the rest of the answer for the new status.

| Answer | Meaning | Do |
| --- | --- | --- |
| `changed: true` | recorded, one row | [Verify](#verify) |
| `changed: false`, row now `REFUNDED` with the same `refund_tx` | the record landed and the response was lost, or you re-posted | nothing, it is done |
| `changed: false`, row is `REFUND_SENDING` | a worker holds the claim and may be mid-send | re-read the row, wait for the lease, and do not force it |
| `changed: false`, row is `REFUNDED` with a different `refund_tx` | someone recorded a different transaction | stop and investigate before anything else |
| `409 service_delivered` | the row is `SETTLED` and the session reached `READY`; the refund is not obvious | escalate before refunding anything |
| `404 not_found` | wrong identifier | check the key, or pass the EIP-3009 nonce instead |

That endpoint is `markRefunded` (`controller/src/store/postgres/ledger.ts`),
guarded on `status IN ('SETTLED','REFUND_PENDING')`. It deliberately refuses
`REFUND_SENDING`, because the worker may be mid-send.

### 4. Only if the control API is unreachable

The same statement the endpoint runs. Keep the `WHERE` exactly as written: the
status predicate is the guard.

```sql
UPDATE payment_ledger
   SET status = 'REFUNDED',
       refund_tx = '<transaction>',
       reason = 'manual_refund:<ticket>',
       refund_claim_token = NULL,
       refund_claimed_at = NULL,
       updated_at = (extract(epoch FROM now()) * 1000)::bigint
 WHERE payment_key = '<payment_key>'
   AND status IN ('SETTLED', 'REFUND_PENDING')
RETURNING payment_key, status;
```

Exactly one row must come back. Zero rows means the row moved while you were
reading it; re-read the status and stop. Never drop the `AND status IN (...)`
clause, and never run it for a row you did not send funds for.

### Why this cannot pay twice, and the one way it can

This procedure cannot pay the same payment twice, by construction here and by
key at the provider:

- every send carries `refund:<payment_key>`, and the provider contract is that
  the same key returns the original transaction and moves no funds again;
- on this side, a claimed row is fenced by `refund_claim_token`: completion
  matches the token, so a pass that lost its claim cannot record anything;
- the manual endpoint refuses `REFUND_SENDING`, so it cannot race a send in
  flight, and its `UPDATE` only touches `SETTLED` or `REFUND_PENDING`.

The way it can still happen is a send with a **different** key, which in
practice means a provider dashboard button that does not accept an idempotency
key, or a key derived from something other than the payment key. If the worker
then retries with `refund:<payment_key>`, the provider sees two requests and a
customer can be paid twice. If that has already happened, stop the sender before
anything else: set `REFUND_WEBHOOK_URL` empty in `control-config` and
`kubectl -n sandbox-system rollout restart deploy/controller`, then reconcile
against the provider and the chain.

Also true, and worth saying out loud: if the provider ignores `Idempotency-Key`,
no procedure here is a proof of one transfer. The key is a request, which is the
limit ADR 0011 records.

## Verify

1. The row is terminal and carries a transaction:

   ```sql
   SELECT payment_key, status, refund_tx, refund_attempts, refund_last_error,
          to_timestamp(updated_at / 1000.0) AS updated_at
     FROM payment_ledger WHERE payment_key = '<payment_key>';
   ```

2. The gauge falls. A manual refund goes through `markRefunded`, not the worker,
   so neither `sandbox_refund_worker_total` nor `sandbox_refunds_total` moves;
   only the row and the count change:

   ```bash
   kubectl -n sandbox-system port-forward deploy/controller 19100:9100 &
   curl -s http://127.0.0.1:19100/metrics | grep -E '^sandbox_refunds_(pending|sending) '
   ```

3. The provider shows one transfer for `refund:<payment_key>`, and the
   transaction id matches `refund_tx`.
4. `SandboxRefundBacklog` resolves within one `for` window (10 minutes), and
   `SandboxLedgerDivergence` stays at zero.

## Preserve evidence

The row is the record, so capture it before you overwrite `reason` and
`updated_at`:

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "incident-$STAMP"
kubectl -n sandbox-system exec -c postgres postgres-0 -- \
  psql -U sandbox -d sandbox -c "\copy (SELECT * FROM payment_ledger WHERE payment_key = '<payment_key>') TO STDOUT WITH CSV HEADER" \
  > "incident-$STAMP/ledger-row.csv"
kubectl -n sandbox-system logs deploy/controller --since=24h > "incident-$STAMP/controller.log"
kubectl -n sandbox-system get configmap control-config -o yaml > "incident-$STAMP/control-config.yaml"
curl -s http://127.0.0.1:19100/metrics | grep -E '^sandbox_refund' > "incident-$STAMP/refund-metrics.txt"
```

The ledger row holds a payer address, which is customer identity. Keep the file
with the incident, not in a shared channel.

## What to tell the customer

Send it after the transaction exists, not before. Name the amount, the asset,
the network, the transaction and a time to come back to.

```text
Thanks for the report. Your payment of <amount> <asset> on <network> did not
produce a working session, so it is being refunded in full. The refund was sent
as <transaction> at <time UTC>. A transfer on <network> usually confirms in under
a minute; the funds go back to the address that paid.

If it has not arrived by <time + 1 hour>, reply here and we will trace the
transaction. Your reference is <TICKET>.
```

Do not promise a confirmation time beyond what the network usually does, do not
name a cause you have not confirmed, and do not say "refunded" until `refund_tx`
is set. If the row was exhausted rather than sent, the honest version is that the
refund is being handled manually and the transaction follows in the next message.

## Where the ORR is out of date about refunds

[orr.md](../orr.md) is the operations readiness record and is not edited here.
Three of its refund statements no longer describe this code:

- §7 says that stopping the controller means the refunds start and "reconcile by
  hand, because nothing here will do it for you". The second half is stale.
  `RefundService.reconcile()` runs in every housekeeping pass and repairs a
  terminal-before-`READY` row still `SETTLED`, including relay-loss rows and a
  payment recorded with no entitlement, and the refund worker then resolves it.
  What still holds is the transfer: with no `REFUND_WEBHOOK_URL`, nothing sends
  money and the reconcile only makes the debt visible.
- §11 lists incident detection as leaning on log lines "because the matching
  alerts are missing". For refunds that is no longer true: the deployment
  repository now ships `SandboxRefundBacklog`, `SandboxRefundStuck`,
  `SandboxRefundSendingStuck`, `SandboxRefundExhausted`,
  `SandboxRefundWorkerSilent` and `SandboxSettlementWithoutEntitlement`. The
  separate gap, "No alert is delivered to a person", still stands until
  delivery is proven end to end, so the customer is still partly the monitoring.
- §5 says the deployment evaluates 23 rules, and lists "settlement failures as
  their own signal" among the families that are not implemented. The count now
  describes the contract file only: the deployment loads 29, because the refund
  group is a second ConfigMap next to it. The settlement-failure gap is still
  real and this runbook does not close it. A thrown settle is `unknown` and
  counted nowhere; a refused settle answers `402 payment_settle_failed`, the
  same status every unpaid request gets. `sandbox_settlement_recovery_total` is
  the only exported signal, and it counts a settled payment that was written up
  as a debt after the fact, not a settle that failed.

Everything else in the ORR about refunds still holds, including the two that
matter most: no real refund has ever executed, and an ambiguous outcome retries
with the same key with no time bound. One refinement on the second: an unknown
outcome consumes no attempt, so only a row at `REFUND_MAX_ATTEMPTS` stops
retrying, and that row is the one `SandboxRefundExhausted` reports.

## Known gaps

- No alert has been delivered to a person yet. The rules exist and deliver to the
  Hermes agent; proving the last hop is ORR launch checklist step 6.
- `sandbox_refunds_pending` is a count, not an age, so one row and fifty rows
  look the same on a dashboard. The age is only in the SQL.
- An ambiguous send has no time bound on this side: it consumes no attempt and
  retries forever, so nothing in the metrics says "unknown since Tuesday". The
  row's `refund_claimed_at` is the only evidence.
- The provider's dedupe is a contract, not a proof. Nothing here verifies that a
  provider honoured `refund:<payment_key>`.
- `markRefunded` accepts any transaction string. A typo makes the books say
  refunded while the customer got nothing, which is why the order in
  [Recover](#recover) is funds first.
- There is no customer-facing refund status, no email and no credit mechanism.
  The message above is sent by hand.

## Related

- [payment-ledger.md](../payment-ledger.md): the ledger, the refund policy and
  the operator endpoints
- [ADR 0011](../adr/0011-durable-external-calls.md): claim, fence, retry and
  what "effectively once" does not guarantee
- [lifecycle.md](../lifecycle.md): terminal session states behind the policy
- [control-plane-faults.md](../control-plane-faults.md): what a controller crash
  leaves behind
- [tabletop.md](tabletop.md): rehearse this runbook before it is needed
