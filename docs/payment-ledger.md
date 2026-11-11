# Payment ledger and refunds

Status: durable ledger, terminal-refund policy, settlement reconciliation and
an opt-in refund worker are implemented. Mock payments refund automatically;
real payment modes leave an explicit `REFUND_PENDING` until an operator-configured
refund endpoint resolves it, or the attempts run out. No partial refunds or
customer credits yet. **None of the real-money path has been executed against a
real facilitator or a real chain**: see [Limits](#limits).

## States

```text
SETTLED ──> REFUND_PENDING ──> REFUNDED
   └──────────────────────────> REFUNDED   (mock auto-refund or manual)
```

A ledger row is written in the **same SQLite transaction** as the payment,
session and payment-intent settlement in `Store.completeEntitlement`. There is
never a session without a ledger row, or a ledger row without its entitlement.

| Field | Meaning |
|---|---|
| `payment_key` | x402 payment key; primary key |
| `session_id` | session that consumed the payment; unique |
| `payer`, `amount`, `asset`, `network`, `mode` | payment identity |
| `status` | `SETTLED`, `REFUND_PENDING`, `REFUNDED` |
| `reason` | why a refund was requested |
| `refund_tx` | mock transaction id or operator-supplied real transaction id |
| `settlement_nonce` | EIP-3009 authorisation nonce, so a refund can be keyed by it |
| `refund_attempts`, `refund_last_error`, `refund_next_attempt_at` | refund worker retry state |

## Claim fencing and idempotent completion

`payment_intents` carries a `claim_token` and `claim_expires_at`. The token is
the ownership fence for the outbox:

- The first claim inserts the intent as `claimed` and returns a fresh token.
- A live claim makes a second claim `in_progress`.
- A claim past its recorded lease, or older than the caller's `staleMs` (the
  crash path), is reclaimed with a **new** token. The previous owner is fenced
  out.
- `complete` must present the current token. The check happens inside the same
  `BEGIN IMMEDIATE` transaction that writes the payment, ledger and session
  rows, so a stalled owner that was reclaimed cannot settle.
- Completion is idempotent: if the intent is already `settled`, the caller gets
  the winning `sessionId` and a successful response instead of an error. No
  second payment, ledger row or session is written. Settlement clears the claim
  token and its deadline.

The controller treats a mismatch as `409 stale_claim`. The API turns an
idempotent completion into the normal `200` session response for the same
capability.

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
the retry path and failing the intent here would race a slow settlement.

Recovery needs a facilitator that exposes `GET /settlements/:paymentKey`
(`FACILITATOR_URL`, the mock facilitator does). Without one it is a no-op, and
the `409 reconciliation_pending` behaviour is unchanged.

## Refund policy

A refund is considered only when the session reaches a terminal state with
`ready_at = NULL`:

- provisioning failure, queue timeout, provisioning timeout,
- expiry before READY,
- client destroy before READY.

Once a session has reached READY, the ledger stays `SETTLED`; the customer
received service, and any exception is a manual review.

`RefundService` is invoked after `finalizeTermination`:

- `mode = mock`: writes `REFUNDED` with a `mock:refund:...` transaction id.
- `mode = testnet` (or future real modes): writes `REFUND_PENDING`, with no
  fake on-chain transaction. The refund worker or an operator resolves it.

All transitions are conditional in SQL, so retries and repeated termination
paths cannot refund twice. Housekeeping also scans terminal-before-READY
sessions whose ledger is still `SETTLED`, and settlement rows with no session
(`unsettled:*`, `duplicate:*`), repairing a crash between the write and the
policy.

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
| `REFUND_MAX_ATTEMPTS` | `10` | give up after this many failures |
| `REFUND_RETRY_BASE_MS` | `60000` | first retry delay, doubled per attempt (capped at 1 h) |

`POST $REFUND_WEBHOOK_URL` with
`{paymentKey, settlementNonce, payer, amount, asset, network, mode, reason}` and
expects `200 {"transaction":"<id>"}`. The endpoint holds the signing authority;
this process does not, so a compromised controller cannot move funds by itself.
Every transition is conditional on `status = 'REFUND_PENDING'`, so a retry or a
second worker cannot refund twice. A row that exhausts its attempts stays
`REFUND_PENDING` with `refund_last_error` set, and shows up in the operator
endpoint and the pending gauge.

Metrics: `sandbox_refunds_total{mode,result}` (policy outcomes),
`sandbox_refund_worker_total{result}` (attempted/failed/exhausted),
`sandbox_refunds_pending` (gauge), `sandbox_settlement_recovery_total{result}`.

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
```

The manual endpoint refuses to refund a `SETTLED` ledger whose session reached
READY unless it is already `REFUND_PENDING`.

## Limits

- **The real-money path has never run.** The reconciliation worker and the refund
  worker are exercised against stubs and the mock facilitator. No test in this
  repository has moved testnet funds, and `REFUND_WEBHOOK_URL` has no
  implementation in this repository.
- The refund endpoint protocol (`POST` with a `{transaction}` reply) is a
  contract this repository defines, not one a facilitator provides. A real
  facilitator with a refund API needs an adapter.
- Recovery depends on a settlement lookup the facilitator must expose. Testnet's
  public facilitator does not, so testnet still answers `409
  reconciliation_pending` and the money is only visible to a human who reconciles
  the on-chain transfer.
- No partial refunds, prorating, credits, or a per-payer spend ledger beyond the
  admission budget ([admission-control.md](admission-control.md)).
- The ledger records the payment amount, not fees or net settlement.
- A refund that exhausts its attempts is not escalated: an operator has to find
  it in the pending list and act.
