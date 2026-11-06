# Capacity admission design

Status: implemented. Payment can no longer settle into a session that the
controller already knows it cannot place.

## The race

The x402 flow has three moments:

1. the client asks for a session and receives `402 Payment Required`,
2. the client signs and submits payment,
3. the facilitator verifies and settles.

Capacity can change between (1) and (3). A preflight alone is not enough: two
clients can both see the same free capacity before either pays.

## Protocol

```
POST /v1/sessions (no payment)
  └─ controller preflight ──► 402 or 503 capacity_unavailable

POST /v1/sessions (PAYMENT-SIGNATURE)
  ├─ validate payment header
  ├─ validate spec / payer rate limit
  ├─ controller holdCapacity(paymentKey, specHash, spec)   ◄── authoritative
  │    └─ reject → 503 capacity_unavailable, no settlement
  ├─ claim payment intent
  ├─ verify
  ├─ settle
  └─ controller completeIntent
       └─ attach hold to session (atomic reservation transfer)
```

The **preflight is advisory**. The **hold is authoritative** and happens before
settlement. If capacity disappears after the 402, the client is rejected before
being charged. If capacity disappears after the hold, the reservation still
protects the capacity until the hold expires or is attached.

## Reservation keying

A hold is keyed by the settled payment key:

- `payment_key` is unique in `reservations`,
- the hold is bound to `spec_hash`,
- a retry with the same payment returns the same reservation,
- a different payment cannot claim the same hold,
- a different spec for the same payment is rejected.

The session reservation retains the same row; `payment_key`, `session_id` and
`state=ALLOCATED` are set when the entitlement is created. There is no
"release hold then create session" window.

## Rejection shape

```json
{
  "error": "capacity_unavailable",
  "retryable": true,
  "reason": "insufficient_memory",
  "requested": {
    "cpuMillicores": 1000,
    "memoryBytes": 536870912,
    "storageBytes": 402653184
  }
}
```

`Retry-After` is set for retryable rejections. No other customer's session id,
node name or capacity details are exposed.

## Atomicity limits

What is atomic:

- reservation decision + insert in one SQLite `BEGIN IMMEDIATE`,
- hold transfer to a session in one transaction,
- one reservation per payment/session via unique constraints.

What is **not** atomic:

- Kubernetes scheduling versus the SQLite reservation. The model is capacity
  planning; a node can still reject the Pod or a Pod can land later than
  expected. The controller pins cold pods to the reserved node and relies on
  provisioning timeout/reconciliation for the residual race.
- payment settlement versus the reservation. The hold is created before
  settlement and has a TTL; if settlement succeeds but completion fails, the
  hold remains until the client retries or it expires. There is no refund
  mechanism in this prototype.
- multiple controllers. SQLite is the single writer. A multi-controller
  deployment needs an equivalent conditional write (Postgres transaction,
  DynamoDB conditional put) and a shared node snapshot; in-memory counters are
  not sufficient.

## Settlement succeeds, capacity is gone

This can happen only if:

- the hold expired between settlement and entitlement completion, or
- the hold was released by an operator/error path.

`completeIntent` tries to attach the hold; if it cannot, it returns
`409 capacity_unavailable` without creating the session. The API returns `503`
with "payment settled but capacity is no longer available; retry with the same
payment". The payment intent stays durable and can be retried; this is a
documented prototype limitation, not a production refund policy.

The normal path is fail-closed: hold before settle, attach immediately after
settle, hold TTL default 120 s.

## Capacity rejection status

| Case | Status | Retryable |
|---|---:|---|
| preflight/hold capacity exhaustion | 503 | yes |
| invalid request / affinity mismatch | 409 | no |
| controller unavailable | 503 | yes |
| resume capacity exhaustion | 409 | yes |

Resume returns 409 because the session is durable and the client can retry the
same `resume` call after capacity is released.
