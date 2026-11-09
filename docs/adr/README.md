# ADR index

Architecture decision records for choices that are expensive to reverse or that
shape the trust boundary. Each record states the decision, the alternatives that
were rejected, and the cost we accepted.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-capability-from-payment.md) | Derive the session capability from the settled payment | accepted |
| [0002](0002-ciphertext-only-control-plane.md) | The control plane handles ciphertext only | accepted |
| [0003](0003-guest-initiated-relay.md) | The guest dials out to a relay; no ingress | accepted |
| [0004](0004-sqlite-single-writer.md) | SQLite as the single writer, with an outbox | accepted |
| [0005](0005-kata-isolation-boundary.md) | Kata microVMs as the isolation boundary | accepted |
| [0006](0006-immutable-lease.md) | The lease is immutable and enforced in three places | accepted |

## Writing a record

Add one when a change alters a trust boundary, a durability guarantee, or a
deployment constraint — or when a future reader would reasonably ask "why not
the obvious thing?". Keep it under a page. Supersede rather than rewrite: mark
the old record `superseded by NNNN` and leave it in place.
