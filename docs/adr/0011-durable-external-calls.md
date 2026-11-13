# 0011. Durable external calls are claimed, fenced and deduped

Status: accepted (2026-11-12). Implemented in `shared/src/durable/` and used by
the refund worker (#31) and the grant path.

## Context

Two calls in this service move money, and both are at-least-once by nature:

- the refund worker claims a ledger row, POSTs an operator webhook, and records
  the provider's transaction;
- the grant path claims a payment intent, settles with the facilitator, and
  writes payment, ledger and session in one transaction.

The protocol was written twice. The refund worker owned its backoff arithmetic,
the refund claim query owned the lease comparison, the intent claim owned a
second expiry check, and "a lost answer is not a refusal" lived only in the
refund executor. A second copy of a protocol is a second place to get that last
rule wrong, and the wrong version spends a finite retry budget on work that may
already have moved funds.

## Decision

One pure module, `shared/src/durable`, with five pieces and no I/O. It lives in
`shared` rather than beside the controller because the API consumes it too and
cannot import controller sources, and because a module with no database client is
the pure layer's job:

| Piece | What it owns |
|---|---|
| `keys.ts` | `refund:<paymentKey>`, `settlement:<paymentKey>`, parsing, one prefix source |
| `claim.ts` | fence token, lease value object, `isExpired`, `reclaimable`, `claimDecision`, `isHeldBy` |
| `retry.ts` | attempts, exponential backoff with a ceiling, lease longer than the call timeout |
| `outcome.ts` | `ok`, `definite_failure`, `unknown`, and the HTTP / network classifier |
| `run-claimed.ts` | send, record, release: the order, with `complete` and `fail` as callbacks |

SQL, transactions and unique constraints stay in the Postgres adapters. There is
no generic operations table: the fence lives on the row that owns the effect, so
there is never a claim row and an effect row that can disagree.

The protocol, in order:

1. **Name the work from the payment** before the first send. The key is
   `kind:paymentKey`, derived, never assigned, never rewritten.
2. **Claim durably** with a fresh token and a lease. The write is conditional, so
   two owners never hold the same work.
3. **Send** with the key, inside a timeout shorter than the lease.
4. **Classify the answer.** `ok` carries a result, `definite_failure` is a
   refusal the provider answered, `unknown` is everything else.
5. **Record under the fence.** Completion requires the current token. A refusal
   counts one attempt and arms the backoff. Unknown writes nothing and waits for
   the lease.

## Invariants

- **One owner per claim.** Enforced by the write, not by the loop: the ledger
  uses `FOR UPDATE SKIP LOCKED` plus a fresh token, the intent uses a conditional
  reclaim of an expired `claim_expires_at`.
- **Only the current token records.** A stale owner that returns after a reclaim
  matches zero rows. `isHeldBy` is the local short-circuit, the `WHERE` clause is
  the decision.
- **Unknown never consumes the definitive failure budget.** A timeout, 5xx, 408,
  429 or unreadable 2xx leaves the row in flight with its attempts unchanged.
- **The key is a function of the payment.** A reclaim changes the owner and the
  deadline, never the name. Two payments never share a key.
- **Attempts are monotonic.** Only a definite refusal increments them, and only
  for the owner that still holds the fence.
- **At most one completion per payment.** The completion transition is terminal
  in SQL; a second write matches zero rows.

## The two consumers

| Primitive | Refund worker | Grant path |
|---|---|---|
| `refundKey` | `Idempotency-Key` header and body on every send | not used |
| `settlementKey` | not used | names the operation in logs; the facilitator has no such header |
| Lease | `refund_claimed_at` plus the worker's lease, compared against `leaseCutoffMs` | absolute `claim_expires_at`, checked with `deadlinePassed` |
| Fence | `refund_claim_token` in the completion and release `UPDATE` | `claim_token` in the reclaim and settle `UPDATE`, plus `FOR UPDATE` on the intent |
| Retry | `refundRetryPolicy`: 10 attempts, 60 s base, 1 h ceiling, 60 s lease over a 10 s call | `staleMs` reclaim only; no attempt budget |
| Outcome | webhook status and thrown error through the algebra | settle response and thrown call through the same algebra |
| `runClaimed` | the per-row loop | deliberately not used, see below |

## What is not guaranteed

- **Not exactly-once.** It is effectively-once, and only because the provider
  dedupes the key. The webhook protocol in `docs/payment-ledger.md` is a contract
  this repository defines; a provider that ignores `Idempotency-Key` can be paid
  twice across a crash and the ledger cannot detect it.
- **Grant-path dedupe is the nonce, not a header.** The x402 facilitator settle
  call has no `Idempotency-Key`; mechanisms dedupe by the EIP-3009 authorisation
  nonce inside the signed payload, on the facilitator side. So `settlementKey`
  names the operation and the classifier decides unknown vs refusal. Do not read
  it as a header that the facilitator honours.
- **A crash before the key is durable is not recoverable.** The key is committed
  by the claim write, before any send, so an in-protocol crash at that point means
  no send happened and the next pass starts clean. A transfer made outside the
  claim (an operator moving funds by hand, or a future caller that sends first)
  has no durable key and no row for this service to reconcile against.
- **Unknown retries are unbounded.** `REFUND_MAX_ATTEMPTS` bounds definite
  refusals only. An ambiguous row stays `REFUND_SENDING` and is retried every
  lease with the same key, which is deliberate: giving up on a payment that may
  have moved is worse than a gauge that stays above zero.
- **The lease is a duplicate-send bound, not a stop.** A provider call that
  outlives the lease can overlap a reclaim. That is safe because the key is
  stable, not because the lease prevented it.
- **The property tests are not the oracle.** They model the protocol against an
  in-memory row. The Postgres integration and concurrency tests are what pin the
  adapters.

## The asymmetry, deliberately kept

`runClaimed` is used by the refund worker and not by `completeEntitlement`. That
transaction has a linearisation point (the `UPDATE ... RETURNING session_id` that
clears the claim token) and an advisory lock on the client key pair. Wrapping it
in a generic callback would hide exactly the lines a reviewer needs to see. The
grant path therefore uses the primitives (lease arithmetic, fence predicate,
classifier, key naming) and keeps its own transaction.

The refund path also has something the grant path does not: a finite attempt
budget. The grant path has a client who can retry, so an exhausted counter would
be a second policy on top of the client's.

## Failure windows

| Window | Durable state | What happens | Result |
|---|---|---|---|
| crash before the claim commits | nothing claimed, nothing sent | next pass claims | no duplicate |
| crash after the claim, before the send | `REFUND_SENDING`, lease, key | lease expires, reclaim, send | at most one transfer, key dedupes |
| crash after the provider paid, before completion | `REFUND_SENDING`, lease, key | reclaim resends, provider returns the original transaction | effectively once |
| timeout, 5xx, unreadable 2xx | `REFUND_SENDING`, attempts unchanged | unknown, waits for the lease | retried indefinitely |
| stale owner returns after reclaim | new owner holds the token | completion and release match zero rows | stale owner records nothing |
| completion write fails | `REFUND_SENDING`, lease | unknown, reclaim resends | effectively once |
| provider ignores the key | nothing detects it | two transfers | broken provider contract |

## Consequences

- `@x402s/shared/durable` is a new pure entry point. `scripts/check-structure.mjs`
  lists `durable/` in the pure layer, so it cannot grow a database import.
- The refund worker's per-row branch is a `runClaimed` call and a switch on the
  result. Its SQL contract is unchanged; the claim statement now takes the key
  prefix as a parameter instead of a literal.
- The ledger port types a claim token as `ClaimToken`, so a bare string cannot be
  passed where a fence is expected.
- **One behaviour change on the grant path.** A thrown settle call, or a
  `settlement_pending` answer, no longer fails the intent while a settlement
  lookup is configured. The intent stays `claimed` so `SettlementRecovery` can
  find it. Without a lookup the intent is failed exactly as before, because
  nothing could ever resolve it.
- The two expiry encodings stay. Unifying them would mean a schema change to the
  refund ledger for no behavioural gain, and the asymmetry is now named in one
  place instead of discovered twice.

## Rejected alternatives

- **A generic `external_operations` table.** Two rows to keep consistent (the
  operation and the thing it acts on), or a transaction that spans tables to get
  back to one. The fence belongs on the row whose state the effect changes.
- **A job framework.** Refunds are tens of rows a day, and the grant path is a
  request with a client waiting on it, not a job. A third delivery model to
  operate, on top of the ledger claim and the intent claim, is cost without a
  guarantee.
- **Putting the classifier in the adapter.** The adapter knows the table, not the
  provider. `unknown` has to be decided by the code that saw the answer.
- **Sending `Idempotency-Key` to the facilitator.** The protocol has no such
  header. Adding one would be a request nobody reads.
