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
                                                                  │       SUSPENDING
                                                                  │            │ guest stopped
                                                                  │            ▼
                                                                  │        SUSPENDED
                                                                  │            │ resume
                                                                  │            ▼
                                                                  │        RESUMING
                                                                  │            │ guest hello
                                                                  │            ▼
                                                                  │          READY
                                                                  ▼
                                                             TERMINATING
                                                                  │
                              ┌───────────────────────────────────┼──────────────────────┐
                              ▼                                   ▼                      ▼
                           EXPIRED                             FAILED                DESTROYED
                        (lease ended)                   (provision/guest error)   (client destroy)
```

`SUSPENDING` and `RESUMING` are observable transitional states. A controller
crash during either is repaired by the reconciler: `SUSPENDING` is finished
idempotently and `RESUMING` continues the readiness handshake.

Every terminal transition goes through `TERMINATING` so the controller performs
one cleanup sequence (ask the guest to stop → delete pod → purge relay → record
the final state).

## What the customer sees

| State | Meaning | Allowed operations |
| --- | --- | --- |
| `PAID` | payment settled, entitlement durable | none (poll) |
| `PROVISIONING` | pod scheduled/starting | none (poll) |
| `READY` | guest connected, attested, lease started | exec/files |
| `ACTIVE` | an operation is in flight (single operation slot) | exec/files |
| `SUSPENDING` | checkpoint in progress; compute still winding down | none |
| `SUSPENDED` | checkpointed, no compute; workspace PVC retained | none (resume first) |
| `RESUMING` | restoring the workspace into a fresh guest | none (poll) |
| `TERMINATING` | shutdown in progress | none |
| `EXPIRED` | lease elapsed | none |
| `FAILED` | provisioning/guest failure | none |
| `DESTROYED` | client destroyed it, cleanup done | none |

`READY` and `ACTIVE` are both usable. `ACTIVE` is **transient**: claiming the
single operation slot moves READY → ACTIVE, and finishing the operation returns
to READY. It is not a "has been used" marker.

The transition table is pure (`shared/src/domain/session.ts`). Every state change
executes the effect list its transition returns through
`controller/src/effects.ts`, and the store's SQL guards are generated from the
table's `SOURCE_STATES` map; a unit test asserts that map matches `transition()`
for every state/event pair. Admission in front of a create (queue slot, relay
readiness, capacity reservation, shard endpoint) is the shell's, not an effect:
a prerequisite that is not ready leaves the session where it is.

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
- `requestId` is the idempotency key, bound to the operation: the client sends a
  SHA-256 of the canonical operation plaintext, so retrying with the same id and
  operation returns the cached result even though the envelope was re-sealed,
  while reusing the id for a different operation is refused with `409
  idempotency_key_reused`. Without the client hash the controller hashes the
  ciphertext instead (schema v16, `exec_requests.payload_hash`) and a re-sealed
  retry is treated as a different payload.
- The result is written to `exec_requests.result_envelope` when the controller
  observes it, so a retry is answerable for as long as the request row lives
  (schema v17), not only for the relay's 5 minute cache window. The stored value
  is the same client-sealed envelope the relay held: the controller has no key
  for it and cannot open it. One bound applies, `MAX_PERSISTED_RESULT_BYTES`
  (1 MiB): a larger envelope is not stored at all, never truncated, and the
  result keeps the cache-only behaviour. `result_envelope` is cleared when the
  session reaches a terminal state, in the same transaction as the finalize;
  the request rows themselves stay for audit.
- Results are cached at the relay for 5 minutes and 64 entries per session so a
  client can reconnect with `GET /v1/sessions/{id}/requests/{requestId}` after a
  disconnect. A miss falls back to the stored envelope above; `410
  result_expired` means neither the relay nor the row still has the result.
- `DELETE /v1/sessions/{id}/requests/{requestId}` cancels the running command;
  the guest returns a result with `cancelled: true` and the session stays usable.
- File operations travel through the same single-operation gate.
- Long-running local services (`service.start`) also use the gate for
  start/stop/list and HTTP requests; a service process itself persists between
  operations. Services are stopped on suspend, terminate and lease end, so they
  do not survive a checkpoint; restart them after resume.

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
- The SQLite database stores metadata only (state, timings, hashes, limits) plus
  the client-sealed result envelopes described above, which the controller
  cannot open and clears at terminal; terminal rows are pruned after 24 h.

## Crash recovery

| Crash point | Behaviour |
| --- | --- |
| After payment settlement, before entitlement | Durable intent (`payment_intents.status = claimed`) + facilitator settlement lookup completes the entitlement on retry; the capability is derived from the payment so the client gets the same session. |
| After entitlement, before pod creation | Session stays `PAID`; the next reconcile provisions it. |
| While `PROVISIONING` | New controller re-registers the relay session, adopts the existing pod (idempotent create) and continues. |
| While `SUSPENDING` | New controller finishes the checkpoint idempotently: stop guest, delete pod, purge relay, mark `SUSPENDED`. |
| While `RESUMING` | New controller adopts the pod and continues the readiness handshake; the provisioning timeout is measured from the resume start, not the original payment. |
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
