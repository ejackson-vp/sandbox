# 0013. A proven address gets a free session from a stable allowlist

Status: accepted (2026-11-13). Implemented in `api/src/use-cases/create-session-allowlist.ts`
and `controller/src/store/postgres/allowlist.ts`.

## Context

The owner and a small set of named wallets (his own agents, friends) should get
sessions without paying. The service has no accounts by design (ADR 0001), so the
only stable identity it has is the wallet address that signs the client
commitment. Everything else is a request field a caller chooses.

Building this naively would create two holes:

- trusting the EIP-3009 `from` field, which the request supplies and nobody has
  verified before settlement;
- minting a payment key that can be reused, replayed, or collide with a real
  payment, so a free session could be re-derived or a paid one re-labelled.

## Decision

One table, `payer_allowlist(address PRIMARY KEY, label, max_tier,
max_concurrent, created_at, disabled_at)`, and one check on the create path.

1. The check happens **after** `proveCommitment` and **before** any facilitator
   call. `proveCommitment` verifies a signature over
   `(paymentKey, clientPublicKey, clientNonce, challengeNonce)` against the
   authorizer address, so the address used for the lookup is one the caller
   proved it controls. A commitment signed by a different key fails earlier, at
   401, and never reaches the allowlist.
2. The ledger key is `sha256("x402-allowlist:v1" | address | challengeNonce)`.
   The domain prefix separates it from a payment key (which hashes a payment
   payload), and the challenge nonce makes it unique per session. A free key
   therefore cannot replay as a real payment, and a real payment cannot be
   re-derived as a free one.
3. The session is recorded with `amount = "0"`, `source = 'allowlist'` and the
   entry's label in the ledger's `reason`. The claimed authorisation value is
   never written: no authorisation was used.
4. The payer's budget row is namespaced `allow:<address>`, so a free session
   cannot consume or exhaust a paying payer's window or concurrency. The
   entry's `max_tier` and `max_concurrent` are enforced on top, in one
   transaction under an address-scoped advisory lock so two concurrent creates
   cannot both pass the ceiling.
5. Every refusal (missing row, disabled row, tier or concurrency ceiling, a
   signer that is not listed) falls back to the normal paid path. Only an
   affirmative answer from the controller grants, and a failed lookup refuses
   with 503 rather than charging a wallet that is meant to be free.
6. `PAYER_ALLOWLIST_ENABLED` defaults to `false`. The feature is off unless a
   deployment says otherwise.

## Rejected alternatives

- **A shared free-session token.** One leaked token is free sessions for
  everyone, and revoking it is a redeploy. The address already exists and is
  already proven on every create.
- **Trusting `authorization.from`.** It is a client-chosen field. The commitment
  signature is what proves control, so the lookup keys on the recovered address.
- **Reusing the client's payment key for the free session.** The key is derived
  from a payload the server never verifies for a free session, so it is
  attacker-shaped. Deriving from address + challenge keeps the two worlds apart.
- **Bypassing settlement only.** A free session still goes through the challenge
  burn, budget, capacity hold and intent claim, so it is subject to the same
  replay, admission and idempotency rules as a paid one.
- **A separate free-session table.** Two records of one entitlement, one of them
  invisible to the ledger and its audit.

## Accepted cost

- **A free session still requires a signed payment header.** The client sends
  the same PAYMENT-SIGNATURE it would pay with; the server never verifies or
  settles it. It is an artefact of sharing the create path, and it means an
  allowlisted agent needs a wallet that can sign EIP-712, not just an address.
- **The allowlist is an operator-managed trust list.** Anyone with the admin
  token can add an address and mint free sessions. That is why it is off by
  default, admin-only, and every row is visible with its label.
- **`max_concurrent` is count-based, not reservation-based.** It is read under
  an advisory lock at authorize time; a create that is authorised but never
  completes does not hold a slot, and a slot frees when the session reaches a
  terminal state. That is the same approximation the shared concurrency budget
  makes.
- **No self-service.** There is no endpoint for a wallet to request access, by
  design: nothing unauthenticated creates a free entitlement.
- **The label lives in the ledger's `reason`.** The alternative was another
  column for a display string. Refund candidates filter `source = 'x402'`, so a
  $0 row's reason is never read as a refund reason.
