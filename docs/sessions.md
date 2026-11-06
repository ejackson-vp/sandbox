# Session lifecycle

```text
CREATED ──settle──► PAID ──pod──► PROVISIONING ──guest hello──► READY
                                                                    │ first op
                                                                    ▼
                                                                 ACTIVE
                                                                  │    │
                                                    lease ends ───┘    ├─── DELETE
                                                                  │    │
                                                                  │    └── idle policy
                                                                  │            │
                                                                  │            ▼
                                                                  │        SUSPENDED
                                                                  │            │ resume
                                                                  │            ▼
                                                                  │        PROVISIONING
                                                                  ▼
                                                             TERMINATING
                                                                  │
                              ┌───────────────────────────────────┼──────────────────────┐
                              ▼                                   ▼                      ▼
                           EXPIRED                             FAILED                DESTROYED
                        (lease ended)                   (provision/guest error)   (client destroy)
```

Every terminal transition goes through `TERMINATING` so the controller performs
one cleanup sequence (ask the guest to stop → delete pod → purge relay → record
the final state).

## What the customer sees

| State | Meaning | Allowed operations |
| --- | --- | --- |
| `PAID` | payment settled, entitlement durable | none (poll) |
| `PROVISIONING` | pod scheduled/starting | none (poll) |
| `READY` | guest connected, attested, lease started | exec/files |
| `ACTIVE` | at least one operation has run | exec/files |
| `SUSPENDED` | checkpointed, no compute; workspace PVC retained | none (resume first) |
| `TERMINATING` | shutdown in progress | none |
| `EXPIRED` | lease elapsed | none |
| `FAILED` | provisioning/guest failure | none |
| `DESTROYED` | client destroyed it, cleanup done | none |

`READY` and `ACTIVE` are both usable; `ACTIVE` simply records that the sandbox
has been used.

## Timing rules

- **The lease starts at READY**, not at payment, so provisioning time is not
  billed against the customer. `leaseExpiresAt = readyAt + durationSeconds` for
  the first run. A suspend sets it to `null`; a resume starts a **fresh** lease
  of the purchased duration.
- **`maxLifetimeSeconds`** (≤ 8 h) is a wall-clock cap that includes suspended
  time; it is separate from the lease.
- **Provisioning has its own timeout** (`PROVISIONING_TIMEOUT_MS`, default 90 s).
  Exceeding it terminates the session as `FAILED` with `provisioning_timeout`.
- **No extension**: no API call changes the deadline. Buying more time means
  buying a new session.
- **Per-command timeout**: `min(requested, remaining lease, MAX_COMMAND_SECONDS)`.
  The guest kills the whole process group; the controller deletes the pod if the
  guest does not comply.
- **Grace**: the controller terminates at `leaseExpiresAt + LEASE_GRACE_MS`
  (2 s). Kubernetes `activeDeadlineSeconds` is set to
  `duration + maxCommandSeconds + 300` as a last-resort backstop.

## Operations

- One active foreground operation per sandbox. A second concurrent request gets
  `409 busy` (the SDK can queue with `queueMs`).
- `requestId` is the idempotency key: retrying with the same id returns the
  cached result instead of running the command again.
- Results are cached at the relay for 5 minutes so a client can reconnect with
  `GET /v1/sessions/{id}/requests/{requestId}` after a disconnect.
- `DELETE /v1/sessions/{id}/requests/{requestId}` cancels the running command;
  the guest returns a result with `cancelled: true` and the session stays usable.
- File operations travel through the same single-operation gate.

## Cleanup guarantees

- The pod is deleted on `TERMINATING` (grace 1 s so the guest can kill children).
- The relay drops all ciphertext for the session.
- The workspace is a memory-backed `emptyDir` for ordinary sessions. A
  **suspendable** session (`idlePolicy`) uses a per-session PVC instead, so it
  survives pod deletion; the PVC is deleted on terminate, suspended expiry or
  max lifetime. See [lifecycle.md](lifecycle.md).
- Suspended sessions have no pod and no relay entry; only the PVC remains.
- The reconciler reaps pods whose session is unknown or terminal, and pods older
  than `MAX_POD_AGE_MS`, including after a controller crash.
- The SQLite database stores metadata only (state, timings, hashes, limits) and
  terminal rows are pruned after 24 h.

## Crash recovery

| Crash point | Behaviour |
| --- | --- |
| After payment settlement, before entitlement | Durable intent (`payment_intents.status = claimed`) + facilitator settlement lookup completes the entitlement on retry; the capability is derived from the payment so the client gets the same session. |
| After entitlement, before pod creation | Session stays `PAID`; the next reconcile provisions it. |
| While `PROVISIONING` | New controller re-registers the relay session, adopts the existing pod (idempotent create) and continues. |
| While `ACTIVE` | Lease deadline is in SQLite; the new controller enforces it and deletes the pod. |
| While `TERMINATING` | Cleanup is idempotent and retried on the next tick. |

## Failure semantics

- Payment succeeds but provisioning fails: the session becomes `FAILED`; the
  payment is not refunded automatically (see `production-readiness.md`).
- Payment succeeds but the API crashes before responding: the client retries the
  same request; the outbox returns the same session (`200`) or recovers it from
  settlement state (`201`).
- Guest dies mid-command: the relay reports `guest disconnected`, the operation
  fails, and the session moves to `FAILED` when the reconciler notices the pod.
