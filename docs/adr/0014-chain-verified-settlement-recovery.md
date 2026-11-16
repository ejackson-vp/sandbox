# 0014. Settlement recovery reads the chain, not only the facilitator

Status: accepted (2026-11-15). Closes F-19. Depends on F-17's transfer proof.

## Context

F-10's `SettlementRecovery` records a debt when a payment settled and no
entitlement was created. It asked one source: `GET /settlements/:paymentKey` on
the facilitator. The public testnet facilitator does not expose that route, and
CDP does not document one. On such a network, if the API dies after settlement
and the client never retries, the money moved, no session exists, and no
`REFUND_PENDING` row is written. That is F-19.

The API had an answer for its own retry path, and F-17 sharpened it: the chain
itself. It is not enough to see that the EIP-3009 nonce was used, because a
1-atomic-unit authorisation uses the same nonce as the 50 000-unit one that was
priced. The proof is the nonce's `AuthorizationUsed` log, the `Transfer` in that
transaction, and a check that the transfer paid the server's `PAY_TO` at least
the server's price. F-17 also established the verdict vocabulary this decision
depends on: `not-found` (the nonce is outside the scan window) is *not* a
refusal, because the payment may have settled before the window opened.

The controller could not use any of that, because it did not persist the
authorizer, the nonce, or the terms.

## Decision

1. **One verifier, one verdict mapping.** F-17's implementation moves to
   `shared/src/settlement-verifier.ts`, and the mapping from proof to verdict
   lives in `shared/src/settlement-verdict.ts`. Both are exported as
   `@x402s/shared/settlement`. The API and the controller import the same code,
   so "the chain proves the transfer" cannot mean two things. `proven` is
   `settled`, `disproven` is `unsettled`, and `not-found` is `unavailable`.
2. **Record attribution and terms at claim time.** `payment_intents` gains
   `authorizer` and `settlement_nonce` (schema v20, additive). The recipient and
   amount were already in `requirements_json`; they stay the only source of
   terms, on the API path and the recovery path alike. The two new fields travel
   on the existing `POST /internal/payment-intents/claim` request as optional
   fields, so an older API still works and recovery falls back to the lookup. A
   reclaim backfills them with `COALESCE`, never overwrites.
3. **Chain first, lookup second.** For an intent past
   `SETTLEMENT_RECOVERY_GRACE_MS`, the worker asks the chain when the deployment
   is configured for it and the intent's recorded requirements name the
   configured network. It passes the same four values the API passes: the
   recorded authorizer, the recorded nonce, and the recipient and amount from
   the intent's requirements. A used nonce with the wrong recipient or a short
   transfer is `disproven`, which writes nothing. `proven` writes the
   `REFUND_PENDING` row exactly as the lookup path did. `not-found`, a failed
   read, unusable terms, another network, or a pre-v20 row falls back to the
   lookup when one is configured; with neither source the pass is a no-op.
4. **Fail closed on mainnet.** The controller parses `NETWORK`,
   `PAYMENT_RPC_URL`, `PAYMENT_USDC_ADDRESS` and the two scan bounds through the
   same shared parser the API uses. A mainnet controller without an RPC URL
   refuses to start. Mock mode ignores the settings entirely: there is no chain
   under the mock scheme, and mocking must behave as it did.

The `authorizationState`-only read is gone. A fast pre-check is allowed by the
verdict rules only when a negative answer is withheld, and it buys one RPC call
against a scan whose first chunk already answers almost every payment, so it was
not worth a second code path.

## Alternatives rejected

- **Keep the lookup and document the gap.** That is the state F-19 records: on
  the public facilitator the gap is the whole recovery path, not an edge case.
- **Recover on nonce use.** That is the F-17 vulnerability: it records a debt
  for, or grants, a payment that was never made at the required price.
- **Have the controller call the API to recover.** The API holds no intent
  after a crash either, and the controller would gain a dependency on a process
  it exists to survive.
- **Infer settlement from a block explorer or the facilitator's transfer
  list.** Both are weaker than the event and receipt, and neither is documented.
- **Give the controller its own copy of the verifier.** Two copies of the rule
  that decides whether money moved.

## Cost

- A recovery pass can now depend on an RPC endpoint. It is a bounded scan with a
  5 s timeout per call and a hard cap of 12 calls, it never throws out of the
  worker, and a failure defers to the next pass, so the cost is latency, not
  correctness.
- The default window is 90 000 blocks (50 hours on Base). A payment older than
  that is `not-found` for the chain, which is why the lookup fallback stays.
- One more pair of nullable columns on `payment_intents`. No index: the worker
  scans by `status` and `updated_at`, which it already did.
- A mainnet controller can no longer start from a configuration that was enough
  for the API alone: it needs the same `PAYMENT_RPC_URL` the API has.
- The refund is still executed by the refund worker. This decision records the
  debt; it moves no funds.

## Invariants

- A recovery decision is never made on nonce use alone. The proof needs the
  transfer, from the authorizer, to the recorded payee, for at least the recorded
  amount, on the configured USDC contract.
- The terms are the server's: `payTo` and `amount` from the intent's recorded
  requirements, never from a request or a claim.
- The chain answer is used only for the network and USDC contract the
  deployment configured. One contract cannot answer for another chain.
- `not-found` is `unavailable`, never `unsettled`, in both processes.
- The ledger write remains the idempotency point: `payment_key` is the primary
  key and the insert is `ON CONFLICT DO NOTHING`. Two workers, or a worker and a
  retry, cannot write two debts (ADR 0011's fence is not needed for a read whose
  only effect is that insert).
- A disproven transfer never becomes a `REFUND_PENDING` row, and never becomes
  an entitlement.
- The recorded authorizer is the proven payer, not a client-claimed field: the
  API verifies the commitment signature against it before the claim.
