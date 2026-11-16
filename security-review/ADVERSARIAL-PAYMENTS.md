# Adversarial payment tests

Base revision: `eea1569` (main). Suite commit: `62f46a2`, fix commit: `96b1568`.
The attacks are in
`tests/unit/payment-adversarial.test.ts` (36 cases) with their builders in
`tests/helpers/payment-attacks.ts`; the F-21 verdict table is in
`tests/unit/settlement-record.test.ts` (5 cases) and the record's producer in
`tests/unit/mock-facilitator.test.ts` (4 cases). Nothing here reaches a chain:
the facilitator is the repository's own `MockExactFacilitatorScheme` wired as a
resource server, and the chain is the real `UsdcSettlementVerifier` over a fake
reader.

The attack is a hostile client with a real wallet and a real signature, not a
mock of one. A test that passes means the guard fired.

## Result

**37 attacks attempted, 37 blocked.** The last row was the one that succeeded
when this suite was written; it is now fixed and is a passing test.

| Attack | Cases | Result |
|---|---|---|
| 1. 1 atomic unit against a $0.05 requirement, first attempt and every recovery branch | 4 | Blocked |
| 2. Correct amount to the wrong recipient (zero, payer, rewritten `accepted.payTo`, and on recovery) | 4 | Blocked |
| 3. One nonce, two sessions (replay, retry, second client key, fresh challenge nonce) | 4 | Blocked |
| 4. Chain window abuse (outside window, reverted receipt, foreign sender, foreign contract) | 5 | Blocked |
| 5. Allowlist bypass (not listed, disabled, over-tier, over-concurrency, another signer, replayed nonce, fabricated body fields) | 7 | Blocked |
| 6. Commitment over another payment key, challenge nonce, client key, or signer | 4 | Blocked |
| 7. Challenge nonce (reused, expired, unknown, cross-tier pricing) | 5 | Blocked |
| 8. Mainnet with a mock `PAY_TO`, without an RPC, with a key pair over http | 3 | Blocked |
| 9. Lookup trusted without a transfer proof (F-21) | 1 | Blocked since the fix |

What held, and where:

- The amount and the recipient are decided by the server's requirement in four
  independent places: `decodePayment` for the advertised amount
  (`create-session-stages.ts:95`), the facilitator's `validate` for the signed
  authorization, the chain check for the transfer, and since F-21 the settlement
  record for a recovery. A 1-unit authorization is refused on the first attempt
  and on all three recovery branches.
- A payment cannot mint a capability for a client key it did not sign, because
  the capability is an HMAC over the payment key and the commitment, and the
  replay path re-derives it and refuses when no key reproduces the stored hash
  (409 `capability_key_retired`).
- The challenge nonce carries no price and no tier, which is correct: a nonce
  obtained while quoting `short` still costs `$0.20` when the body asks for
  `long`, and a `short` payment for a `standard` session is refused with
  `payment_requirements_mismatch`.

## F-21: a settlement record proves a key was used, not that the requirement was paid

**Status:** found by this suite at `eea1569`, fixed on `test/adversarial-payments`.
**Severity:** Medium in the deployed mock deployment; testnet and mainnet were
never exposed.
**Confidence:** proven (regression test).
**Where:** `recoverSettlement` in `api/src/payments/settlement-confirmation.ts`,
and the record producer in `api/src/mock-facilitator.ts`.

**The path, exactly as the test executed it before the fix:**

1. The payer posts a create whose payment header advertises the server's amount
   (`accepted.amount = 50000`) and whose EIP-712 authorization sends 50 000
   units to **the payer's own address**. `decodePayment` compares `network` and
   `amount` only, so it passes.
2. `verifyAndSettle` asks the facilitator, which refuses with `payto_mismatch`.
   The client gets 402 and the capacity hold is released, but the **intent row
   stays `claimed`**: `!verify.isValid` returns without calling `failIntent`
   (`create-session-stages.ts:443`).
3. The payer settles its own authorization. A facilitator settles the
   requirements its caller hands it, so this is a valid 50 000-unit transfer to
   the payer.
4. After the claim lease expires (30 s by default, `staleMs: 0` in the test),
   the next create with the same header and body is reclaimed:
   `claimIntent` answers `claimed, recovered: true`.
5. `createSession` calls `recoverSettlement` **before any verify**
   (`create-session.ts:151`). Mock mode wires no chain verifier, so the chain
   answers `unavailable`, and the lookup is `supported`.
6. `recoverSettlement` returned `settled` on `record.settled === true`, without
   comparing `record.amount` to the intent's terms and without any recipient at
   all.

**Effect:** 201 with a session and a capability, and a ledger row that said
`amount: "50000"`, `payTo: 0x…0402`, `source: "x402"`, `transaction:
"mock:self"`. The row claimed the money reached `PAY_TO`; it did not.

**Why it was bounded to mock:** `createApp` wires `HttpSettlementLookup` only
for `paymentMode === "mock"`; testnet and mainnet get
`UnsupportedSettlementLookup`, so `recoverSettlement` answers `unknown` and the
create withholds. **The mock deployment was exposed**; no real-money deployment
was. It was still worth fixing rather than accepting:

- mock mode is where this suite runs, so the shape weakened the evidence for the
  recipient property everywhere it is asserted;
- `HttpSettlementLookup` is not mock-specific. One `supported: true` on a real
  network turns a documented, unproven facilitator answer into an entitlement;
- it contradicted `settlement-confirmation.ts`'s own contract, which argues that
  a recipient or amount taken from the request would let the payer decide what
  "settled" means. The record was not the request, but it was equally unproven.

### The fix

`SettlementRecord` gained `recipient` beside the `amount` it already carried, and
`recoverSettlement` now holds the lookup to the same standard as the chain. The
verdict table, all four rows pinned by tests:

| Record | Verdict | Create path |
|---|---|---|
| `recipient` equals `PAY_TO`, `amount >= requirement.amount` | `settled` | 201, one entitlement (mock mode) |
| right amount, another recipient | `disproven` | 402, `failIntent` recorded, no entitlement |
| right recipient, amount one atomic unit short | `disproven` | 402, `failIntent` recorded, no entitlement |
| `recipient` or `amount` missing or unusable | `unknown` | 503 `payment_unconfirmed`, retryable, intent stays claimed |

A record that cannot answer is withheld, not refused: the reconciliation window
stays open and the client retries with the same payment. A record that answers
with the wrong recipient or a short amount positively contradicts the
requirement, so it is a refusal. The address comparison checks the 20-byte shape
and compares case-insensitively; there is no substring or prefix match.

**The producer:** `MockExactFacilitatorScheme.settle` now hands the nonce store
`recipient: authorization.to` beside `amount: authorization.value`, and the mock
facilitator stores both and returns both from `GET /settlements/:paymentKey`.
Neither field comes from the caller's requirements. A database written by the
previous build gets a nullable column, so an old row reads as "settled but
unprovable": a withhold, never a bad grant. The controller's recovery worker is
unchanged and still records a debt from `settled: true`, which is the right
distinction: a debt needs to exist, an entitlement needs to be earned.

**Regression:** `tests/unit/settlement-record.test.ts` (the table above and the
end-to-end self-addressed attack), `tests/unit/mock-facilitator.test.ts` (the
record reports the authorisation's recipient and value, and never stores a
settlement it refused), plus the integration recovery test in
`tests/integration/api-payments.test.ts` that settles through the real
facilitator over HTTP and still gets 201.

**Contributing factor, not a second bug:** a definite verify failure leaves the
intent `claimed` for the stale window. That is deliberate (`F-10`: a refused
verify may be a facilitator disagreement, and the payment may still land), but
it is what gave that path somewhere to come back to.

## Harness changes

`tests/helpers/create-route.ts` gained optional seams, all defaulting to the
previous behaviour; the rest of the unit suite is unchanged and still passes.

- `account`: the wallet that signs the header and the commitment, so a header
  can be replayed across two creates.
- `paymentHeader`: present a header verbatim.
- `challengeNonce`: which challenge the body claims.
- `commitmentMessage`: what the wallet actually signs, to attack the binding.
- `requirementFor`: price from the resolved spec, so a tier is really priced.
- the real capability ring (`mintCapability` / `recoverCapability`), so a replay
  is judged against the production HMAC instead of a constant.

## Tests that could not be written

1. **A settlement record injected end to end through the API's own HTTP lookup.**
   The API's handling of a record is tested with `settlementLookup` injected, and
   the producer is tested over HTTP against the real mock facilitator, but no
   single unit test spans both: that leg is covered only by the integration suite
   (`tests/integration/api-payments.test.ts`).
2. **A payment to the previous `PAY_TO` after a rotation.** The harness fixes
   the requirement's `payTo`, and there is no seam to change the server's own
   terms mid-test. A wrong address exercises the same guard, so the rotation
   case is inferred, not proven.
3. **The controller's HTTP answers.** For the F-21 attack, `claimIntent` is
   wired to a real Postgres store so `recovered: true` is produced by the real
   claim logic. The
   other branches (`in_progress`, `mismatch`) still use stubs, because
   `postCreate` builds its own controller.
4. **Two real 402 challenges.** `payment402` is a stub in the harness, so "a
   nonce issued for one tier" reuses one nonce constant rather than two
   challenges from two responses.

## One sentence for the gate

A session is granted only when the chain proves the transfer or the facilitator's
settlement record names the recipient and the amount that moved, so the amount
and recipient are bound on every path, mock included (F-21).
