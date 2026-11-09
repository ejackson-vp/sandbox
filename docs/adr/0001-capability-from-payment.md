# 0001. Derive the session capability from the settled payment

Status: accepted

## Context

The service has no accounts. A client pays for one session and must be able to
act on exactly that session, including across retries, without a registration
step or a user database. The two obvious designs both fail the requirement:

- an account and API key reintroduces signup, revocation and a credential store;
- a random opaque token works, but a retry after a lost response creates a
  second session or loses the first, because nothing ties the token to the
  payment.

## Decision

The session capability is `HMAC(serverSecret, paymentKey)`. The API stores only
its SHA-256 hash. The settled payment is written to a durable intent table
before the session exists, so replaying the same payment key recovers the same
capability and the same session rather than minting a second one.

The capability is therefore a function of the payment, not a record created
beside it.

## Consequences

- Retries are idempotent for free: same payment, same capability, same session.
- There is no account table to breach and no revocation list to maintain.
- Rotating the server secret invalidates capabilities for sessions that are
  still live. Rotation must be coordinated with lease expiry.
- The payment intent must be retained indefinitely, because it is the only
  record that can reproduce the capability.

## Alternatives considered

- **JWT signed by the API.** Stateless and familiar, but it encodes session state
  that the controller owns, and a lost response still leaves the client without
  the token.
- **Random token stored in SQLite.** Simple, but turns every retry into a
  read-then-create race and requires a client-supplied idempotency key.
- **OAuth client credentials.** Solves a problem this service deliberately does
  not have.
