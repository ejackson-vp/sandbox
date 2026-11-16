# Adversarial payment tests

Base revision: `eea1569` (main). The suite is
`tests/unit/payment-adversarial.test.ts` (37 cases) with its builders in
`tests/helpers/payment-attacks.ts`. Nothing here reaches a network: the
facilitator is the repository's own `MockExactFacilitatorScheme` wired as a
resource server, and the chain is the real `UsdcSettlementVerifier` over a fake
reader.

The attack is a hostile client with a real wallet and a real signature, not a
mock of one. A test that passes means the guard fired.

## Result

**37 attacks attempted, 36 blocked, 1 succeeded.**

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
| Lookup trusted without a transfer proof | 1 | **Succeeded (F-21)** |

What held, and where:

- The amount and the recipient are decided by the server's requirement in three
  independent places: `decodePayment` for the advertised amount
  (`create-session-stages.ts:95`), the facilitator's `validate` for the signed
  authorization, and the chain check for the transfer. A 1-unit authorization is
  refused on the first attempt and on all three recovery branches.
- A payment cannot mint a capability for a client key it did not sign, because
  the capability is an HMAC over the payment key and the commitment, and the
  replay path re-derives it and refuses when no key reproduces the stored hash
  (409 `capability_key_retired`).
- The challenge nonce carries no price and no tier, which is correct: a nonce
  obtained while quoting `short` still costs `$0.20` when the body asks for
  `long`, and a `short` payment for a `standard` session is refused with
  `payment_requirements_mismatch`.

## F-21: the settlement lookup is trusted without proving the transfer

**Severity:** Low in the configuration that reaches it today; the guard itself
is one config flag away from a real deployment.
**Confidence:** proven (regression test).
**Where:** `api/src/payments/settlement-confirmation.ts:148-174`.
**Record:** F-21 is written up here, not in `FINDINGS.md`; the next review should
fold it into that table and renumber nothing.

**The path, exactly as the test executes it:**

1. The payer posts a create whose payment header advertises the server's amount
   (`accepted.amount = 50000`) and whose EIP-712 authorization sends 50 000
   units to **the payer's own address**. `decodePayment` compares `network` and
   `amount` only, so it passes.
2. `verifyAndSettle` asks the facilitator, which refuses with `payto_mismatch`.
   The client gets 402 and the capacity hold is released, but the **intent row
   stays `claimed`**: `!verify.isValid` returns without calling `failIntent`
   (`create-session-stages.ts:443`).
3. The payer settles its own authorization. The facilitator settles the
   requirements its caller hands it, so this is a successful 50 000-unit
   transfer to the payer.
4. After the claim lease expires (30 s by default, `staleMs: 0` in the test),
   the next create with the same header and body is reclaimed:
   `claimIntent` answers `claimed, recovered: true`.
5. `createSession` calls `recoverSettlement` **before any verify**
   (`create-session.ts:151`). Mock mode wires no chain verifier, so the chain
   answers `unavailable`, and the lookup is `supported`.
6. `recoverSettlement` returns `settled` on `record.settled === true` without
   comparing `record.amount` to the intent's terms and without any recipient at
   all (`settlement-confirmation.ts:167`).

**Effect:** 201 with a session and a capability, and a ledger row that says
`amount: "50000"`, `payTo: 0x…0402`, `source: "x402"`, `transaction:
"mock:self"`. The row claims the money reached `PAY_TO`; it did not.

**Why it is bounded:** `createApp` wires `HttpSettlementLookup` only for
`paymentMode === "mock"`; testnet and mainnet get `UnsupportedSettlementLookup`,
so `recoverSettlement` answers `unknown` and the create withholds. No real-money
deployment is affected today.

**Why it still matters:**

- Mock mode is where the payment suite runs. A shape that grants a session
  without a transfer to `PAY_TO` weakens the regression evidence for the
  recipient property everywhere it is asserted.
- `HttpSettlementLookup` is not mock-specific. One `supported: true` in a real
  deployment turns this into a free session against a facilitator that will
  settle whatever its caller asks for, which is the facilitator's documented
  role.
- It contradicts `settlement-confirmation.ts`'s own contract: "The requirement
  is always the server's own ... A recipient or amount taken from the request
  would let the payer choose what settled means." The record is not the request,
  but it is equally unproven.

**Regression:** `tests/unit/payment-adversarial.test.ts`, "finding F-21",
written as `it.fails` asserting the correct 402. It will flip to a failure the
day the behaviour is fixed, which is the intent.

**Proposed fix (not applied, tests-only branch):** in `recoverSettlement`,
compare the lookup record to the terms it is about to grant: require
`BigInt(record.amount) >= terms.amount` and add the recipient to
`SettlementRecord` so it can be compared to `terms.payTo`. A record that cannot
prove both is `unknown`, which withholds without closing the reconciliation
window. The narrower alternative is to stop granting from a lookup at all when
no chain verifier exists, and keep the lookup for debt recording only; that
touches the controller's recovery worker, so it is a bigger change than this
finding justifies on its own.

**Contributing factor, not a second bug:** a definite verify failure leaves the
intent `claimed` for the stale window. That is deliberate (`F-10`: a refused
verify may be a facilitator disagreement, and the payment may still land), but
it is what gives step 3 somewhere to come back to.

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

1. **The facilitator's own settlement record.** The mock facilitator keeps a
   nonce store, not a settlement store, so F-21's record is injected through
   `settlementLookup`. The API's handling of a record is what this proves; the
   HTTP leg from `/settle` to `GET /settlements/:key` is not exercised.
2. **A payment to the previous `PAY_TO` after a rotation.** The harness fixes
   the requirement's `payTo`, and there is no seam to change the server's own
   terms mid-test. A wrong address exercises the same guard, so the rotation
   case is inferred, not proven.
3. **The controller's HTTP answers.** For F-21, `claimIntent` is wired to a real
   Postgres store so `recovered: true` is produced by the real claim logic. The
   other branches (`in_progress`, `mismatch`) still use stubs, because
   `postCreate` builds its own controller.
4. **Two real 402 challenges.** `payment402` is a stub in the harness, so "a
   nonce issued for one tier" reuses one nonce constant rather than two
   challenges from two responses.

## One sentence for the gate

The payment gate can claim "a session requires at least the quoted price to
reach `PAY_TO`" only where a chain verifier is configured: in mock mode the
create path grants from a facilitator settlement record that proves neither the
recipient nor the amount (F-21).
