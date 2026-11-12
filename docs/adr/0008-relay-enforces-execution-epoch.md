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
  close frame. The link loss kills the command it was carrying (the supervisor
  aborts and drains it, then reconnects; see ADR 0012), and the fence clears.
- The reset needs the TCP socket captured by the upgrade handler. `attach`
  accepts a nullable socket, and when it is missing the relay falls back to
  `ws.terminate()`, which is a close ordered after the queued frame. The link
  still ends, but in that branch the guarantee is only the observed-frame
  residual below: a frame the guest has not read can still be delivered. The branch is recorded as
  `sandbox_relay_connection_resets_total{mode="tcp_reset"|"terminate"}` and a
  `terminate` also logs `relay_reset_fell_back_to_terminate`.

The guest keeps `admitEpoch` as defence in depth. The model now compares the
same epoch the implementation enforces (`slotEpoch >= execEpoch`, not
`guestEpoch`) and asserts that a command still running under a held fence was
started by an earlier controller generation.

## Consequences

- A frame from a superseded generation cannot start, including one already
  forwarded. The fence keeps its other properties: no overlap, and release only
  on idle or disconnect.
- **A withdrawn frame ends the link, not the session.** The reset is a real
  relay-link loss: the supervisor aborts the command the link was carrying and
  reconnects to the same registration (ADR 0012). The session keeps its lease,
  its Pod and its workspace; the withdrawn frame is gone with the socket. The
  fence may clear on the disconnected branch, because the link loss killed the
  command; the guest then reconnects and reports its slot idle. This is asserted
  end to end by `tests/integration/stale-frame-reset-outcome.test.ts`.
- **The session is not refunded and does not need to be.** It keeps running:
  the lease is unchanged, the interrupted request stays `outcome_unknown`, and a
  new operation runs under the bumped epoch. Only a guest that cannot reconnect
  inside the relay-loss grace ends with `failure:relay_lost` (ADR 0012).
- The controller logs `operation_fence_guest_reset` with the session, request,
  epoch and number of withdrawn frames, so an operator can connect a guest
  reconnect to a recovery reset. The relay logs `relay_epoch_raised` with `reset`
  and the number withdrawn; the counter above says which mechanism ended the
  link.
- A relay restart loses the in-memory floor. Relay recovery re-registers the
  session and the fence republishes the epoch on the next tick; a non-fenced
  session needs no floor because there is no superseded frame to withdraw.

## Follow-up

Guest-side reconnect was implemented after this record: the supervisor keeps the
relay URL/token, abandons and drains the operation the link was carrying, then
re-dials and re-hellos with the same session identity, key and token. See
[ADR 0012](0012-guest-reconnects-after-relay-loss.md). "A command cannot survive
the link" still holds, because the link loss kills it; a disconnected guest is no
longer proof that the command is gone, so `OperationFence` holds a relay-recovery
fence until the reconnected guest reports idle.

## Residual

A frame the guest has already read before the reset reaches it is an observed
frame. It may start, and the fence waits for it. Closing that last window needs
a start-time round trip per command (the guest asks the relay whether the frame
is still current before it takes the slot), a larger protocol change than the
window justifies.

The `terminate` fallback above is this same residual, not a second guarantee:
a close does not discard unread bytes, so a queued frame may still arrive. The
integration test asserts that the `tcp_reset` branch ran before it asserts the
marker file is absent, so a failure has one of two readings from the logs: the
guest read the frame before the reset on a loaded runner (this residual), or the
reset never ran. A non-zero `terminate` count on a real relay is worth a bug.

The Pod-health outcome still depends on the sandbox Pod's `restartPolicy:
Never` (set by `controller/src/k8s-pod.ts`). If a deployment restarted the
container, the guest's bootstrap credential file is already gone
(`guest/config.go` deletes it after first use), so the container would
CrashLoop with the Pod still `Running` and the Pod-health probe would not fire;
the session would only end at the lease deadline or `activeDeadlineSeconds`.
A container restart is not a relay reconnect: it starts a new supervisor with no
key pair and no token, so keeping `restartPolicy: Never` is still required.

There is also a bounded transient between the fence clearing on the
disconnected branch and the guest reconnecting (or the relay-loss grace
ending). During it the session is `READY` with no connected guest: a new
operation is accepted by the gate but its delivery fails with
`guest_not_available`, so it is abandoned and cannot overlap anything. If the
guest comes back the session continues; if it does not, relay recovery ends it
with `failure:relay_lost`.

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
