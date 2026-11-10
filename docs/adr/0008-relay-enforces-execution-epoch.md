# 0008. The relay enforces the session execution epoch

Status: accepted

## Context

The single-operation slot is fenced across a controller restart (#19): startup
marks the interrupted request `outcome_unknown`, bumps `sessions.exec_epoch`,
and keeps the gate closed until the guest reports the slot idle or disconnects.
Every relay frame carries that epoch, and the guest rejects a frame below its
own high-water mark with `stale_epoch`.

That left one window, found by the #75 model. The guest's high-water mark is
per process and only rises when it admits a frame. A frame forwarded by the
previous controller generation, still queued on the guest's socket when recovery
bumps the epoch, is therefore compared with an old (often zero) high-water mark
and can start *after* recovery. The gate stays fenced, so no second command
overlaps it, but the old command can run again while the client is being told
its outcome is `outcome_unknown`.

## Decision

The relay is the execution-epoch authority for a session.

- `OperationFence` publishes the bumped `exec_epoch` to the relay
  (`POST /internal/:sessionId/epoch`) before it may clear the gate.
- The relay keeps a per-session floor and refuses a `request` below it with
  `stale_epoch`; the frame never reaches the guest.
- Raising the floor withdraws a frame that is still awaiting a response. If the
  guest has not itself reported an epoch at or above the floor and has no
  command running, the relay resets the guest connection with a TCP reset, so
  bytes the guest has not read are discarded rather than delivered after a
  close frame. The supervisor exits on the read error, which is the existing
  "a command cannot survive its relay link" contract, and the fence clears.

The guest keeps `admitEpoch` as defence in depth. The model now compares the
same epoch the implementation enforces (`slotEpoch >= execEpoch`, not
`guestEpoch`) and asserts that a command still running under a held fence was
started by an earlier controller generation.

## Consequences

- A frame from a superseded generation cannot start, including one already
  forwarded. The fence keeps its other properties: no overlap, and release only
  on idle or disconnect.
- **A withdrawn frame ends the guest, and therefore the session.** The reset is
  a real relay-link loss: the supervisor exits on the read error, and sandbox
  Pods use `restartPolicy: Never`, so the Pod becomes terminal. The fence clears
  on the disconnected branch (the old command cannot survive the link), the
  reconciler's Pod health probe observes the terminal Pod, and the session
  transitions to `FAILED` with reason `failure:guest_exited`
  (`failureCode: guest_exited`). This is asserted end to end by
  `tests/integration/stale-frame-reset-outcome.test.ts`.
- **No refund for that session.** It had already reached `READY`, so the
  refund policy (`RefundOnlyWhenNoService`) keeps the settled payment. The
  customer loses the remaining lease time. That is the cost of closing the
  window with this contract; it only applies when the previous controller
  generation had forwarded a frame the guest had not read, which is already the
  `outcome_unknown` path for that operation.
- The controller logs `operation_fence_guest_reset` with the session, request,
  epoch and number of withdrawn frames, so an operator can connect
  `failure:guest_exited` to a recovery reset.
- A relay restart loses the in-memory floor. Recovery republishes it on the next
  fence tick; a non-fenced session needs no floor because there is no
  superseded frame to withdraw.

## Follow-up

Guest-side reconnect would let the session continue instead of failing: keep the
relay URL/token in the supervisor, abandon and drain in-flight commands on link
loss (so "a command cannot survive the link" still holds), then re-dial and
re-hello with the same session identity. That is a larger protocol change than
the stale-frame window justifies now, and it must preserve the fence's
disconnect-release argument. Until then, the explicit `guest_exited` failure is
the honest outcome.

## Residual

A frame the guest has already read before the reset reaches it is an observed
frame. It may start, and the fence waits for it. Closing that last window needs
a start-time round trip per command (the guest asks the relay whether the frame
is still current before it takes the slot), a larger protocol change than the
window justifies.

The terminated-session outcome depends on the sandbox Pod's
`restartPolicy: Never` (set by `controller/src/k8s-pod.ts`). If a deployment
restarted the container, the guest's bootstrap credential file is already gone
(`guest/config.go` deletes it after first use), so the container would
CrashLoop with the Pod still `Running` and the Pod-health probe would not fire;
the session would only end at the lease deadline or `activeDeadlineSeconds`.
Any change to the restart policy must land together with the reconnect
follow-up above, or with the bootstrap file re-created per start.

There is also a bounded transient between the fence clearing on the
disconnected branch and the Pod probe reporting terminal (one probe interval
plus one strike, ~2-5s). During it the session is `READY` with no connected
guest: a new operation is accepted by the gate but its delivery fails with
`guest_not_available`, so it is abandoned and cannot overlap anything. The
session then reaches `FAILED`.

## Alternatives considered

- **Deliver the recovery epoch over the existing ordered frame stream.** The
  stale frame is already ahead of it in the queue, so it cannot win the race.
- **Hold the fence longer.** The frame is already in the guest's socket queue;
  the controller's gate does not stop it from starting.
- **Guest-side floor from a control frame.** Same ordering problem; the guest
  learns the new epoch only after it has read the old frame.
- **Drop pending frames without resetting the connection.** Dropping the
  pending entry stops the controller waiting, but the bytes are still on the
  socket. A close frame is ordered after them; only a reset discards them.
