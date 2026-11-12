# ADR index

Architecture decision records for choices that are expensive to reverse or that
shape the trust boundary. Each record states the decision, the alternatives that
were rejected, and the cost we accepted.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-capability-from-payment.md) | Derive the session capability from the settled payment | accepted |
| [0002](0002-ciphertext-only-control-plane.md) | The control plane handles ciphertext only | accepted |
| [0003](0003-guest-initiated-relay.md) | The guest dials out to a relay; no ingress | accepted |
| [0004](0004-sqlite-single-writer.md) | SQLite as the single writer, with an outbox | superseded by 0010 |
| [0005](0005-kata-isolation-boundary.md) | Kata microVMs as the isolation boundary | accepted |
| [0006](0006-immutable-lease.md) | The lease is immutable and enforced in three places | accepted |
| [0007](0007-checkpoint-at-rest-plaintext.md) | Checkpoint workspaces are plaintext, and stay documented as such | accepted |
| [0008](0008-relay-enforces-execution-epoch.md) | The relay enforces the session execution epoch | accepted |
| [0009](0009-leader-election.md) | A Kubernetes Lease elects the single writer | accepted |
| [0010](0010-controller-ha-storage.md) | Controller HA targets a multi-reader store, not an RWX volume | accepted |
| [0011](0011-guest-reconnects-after-relay-loss.md) | A guest reconnects after a relay link loss | accepted |

## Writing a record

Add one when a change alters a trust boundary, a durability guarantee, or a
deployment constraint — or when a future reader would reasonably ask "why not
the obvious thing?". Keep it under a page. Supersede rather than rewrite: mark
the old record `superseded by NNNN` and leave it in place.
