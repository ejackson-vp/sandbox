# 0016. Capabilities are signed by a key ring, not one secret

Status: accepted (supersedes [0001](0001-capability-from-payment.md), 2026-11-16).

> 0001's decision stands: the capability is a function of the settled payment, so
> a retry recovers the same session instead of minting a second one. Two of its
> details do not. It recorded the MAC as `HMAC(serverSecret, paymentKey)` and
> accepted that rotating the secret invalidates live capabilities, which forced
> rotation to be coordinated with lease expiry. The code stopped doing that some
> time before this record: `shared/src/capability.ts` implements a key ring, and
> the MAC input is `x402-capability:v2:<paymentKey>:<commitment>`.
>
> Nothing was wrong at runtime. What was wrong is that the document an operator
> reads before rotating a key described a different system, and the consequence
> it promised was the opposite of the property that was built. This record
> records what the code does, so the next rotation is not a guess.

## Context

A capability is the only credential a paying client holds. It is derived, not
stored: there is no account table and no revocation list. That makes rotation
the one operational lever on the credential, and it has to work without
invalidating sessions that have already been paid for, because a live session
cannot re-derive a credential it has lost.

A single secret makes rotation a flag day: every live capability dies at the
moment of the change, so rotation is only safe when no session is live, which is
never for a service that sells time in 60 to 1800 second units.

The commitment is the second input. It binds the capability to the specific
client key that will seal operations, so a stolen capability cannot be replayed
by a different client, and it is why the MAC input is not just the payment key.

## Decision

Capabilities are signed by a **key ring**: one active signing key and one
verification key.

- `CAPABILITY_KEY_ID` is a short public identifier (`^[A-Za-z0-9_-]{1,16}$`).
  It is part of the credential, not secret, and is sent as
  `<keyId>.<base64url mac>` so a verifier knows which key to use without trying
  all of them.
- `CAPABILITY_SECRET` signs new capabilities.
- `CAPABILITY_PREVIOUS_KEY_ID` and `CAPABILITY_SECRET_PREVIOUS` verify
  capabilities minted before a rotation and are not used to sign anything.
- The MAC input is `x402-capability:v2:<paymentKey>:<commitment>`. The `v2` is
  in the input, not only the format, so a v1 capability can never verify under
  the v2 derivation even if a key is reused.
- Only the SHA-256 of the capability is stored. The credential itself exists in
  the response to the client and nowhere else.

Rotation is therefore: move the active key to previous, install a new active
key, restart. Capabilities minted under the old key keep verifying until the
session they belong to ends. Dropping the previous key is the deliberate step
that invalidates anything older, and it is safe once no session from before the
rotation is live.

## Consequences

- Rotation does not interrupt paid sessions. The window is bounded by session
  lifetime, not by an operator finding a quiet moment.
- The previous key is a second secret in the deployment. It must be rotated to
  the active slot on the next rotation rather than left in place indefinitely;
  leaving it is not a leak, but it widens the window in which a compromised old
  key still verifies.
- A capability carries its key id in plaintext, so an attacker learns which key
  version is in use. That is not useful without the secret, and it is the price
  of not trying every key on every request.
- Two keys exist at once, so a rotation that installs the new active key but
  forgets the previous one fails closed: old capabilities stop verifying and
  those sessions 401. The failure is loud and immediate, not silent.
- The payment intent is still retained indefinitely, for 0001's original reason.

## Alternatives considered

- **One secret, rotate at a quiet moment.** Rejected: it converts a routine
  operation into an outage, and "quiet moment" is not a thing a paid service has.
- **JWT with a `kid` header.** Rejected for the same reason as in 0001: it
  encodes state the controller owns, and a lost response still leaves the client
  without a token.
- **Sign with every key in the ring and accept any.** Rejected: it hides which
  key is active and makes the rotation step unobservable.
- **HMAC over the payment key alone, without the commitment.** Rejected: a
  capability would no longer be bound to the client key that seals operations,
  so a leaked capability could be used by anyone who also saw the payment key.

## Verification

- `shared/src/capability.ts`: `mintCapability`, `verifyCapability`, and the
  `v2` derivation live here; the ring is `{ signing, verify[] }`.
- `tests/unit/capability-rotation.test.ts` and
  `tests/unit/sessions-capability-rotation.test.ts` cover a capability minted
  under the previous key verifying after rotation, and a wrong key id failing.
- `api/src/config.ts:301-316` refuses a previous secret without a key id, a
  previous secret equal to the active one, a reused key id, and a previous
  secret equal to the controller admin token. A key id set without a secret is
  accepted and simply adds no verifier, which is harmless but is not the same
  thing as a pairing check; a half-configured rotation fails closed at verify
  time rather than at startup.
