# Payment ledger and refunds

Status: durable ledger and terminal-refund policy implemented. Mock payments
refund automatically; real payment modes leave an explicit `REFUND_PENDING`.
No partial refunds or customer credits yet.

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
  fake on-chain transaction. The operator or a later refund worker resolves it.

All transitions are conditional in SQL, so retries and repeated termination
paths cannot refund twice. Housekeeping also scans terminal-before-READY
sessions whose ledger is still `SETTLED`, repairing a crash between
finalisation and the refund write.

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
```

The manual endpoint refuses to refund a `SETTLED` ledger whose session reached
READY unless it is already `REFUND_PENDING`.

## Limits

- Settlement recovery before entitlement is still handled by the facilitator
  lookup (`SettlementLookup`), not by this ledger. A crash between settlement
  and `completeEntitlement` therefore has no ledger row yet.
- No partial refunds, prorating, credits, or per-payer spend ledger.
- No automatic on-chain refund worker. Real modes remain `REFUND_PENDING`
  until an operator or worker supplies a transaction id.
- The ledger records the payment amount, not fees or net settlement.
