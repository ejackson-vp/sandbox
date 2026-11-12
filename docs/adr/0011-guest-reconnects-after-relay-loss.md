# 0011. A guest reconnects after a relay link loss

Status: accepted

## Context

The relay registry is in memory, one process per shard, so a relay restart
(rollout, OOM kill, node drain) drops every guest socket on that shard. With a
single replica that is every active session.

The supervisor used to treat any relay read error as terminal: it exited, the
Pod went terminal (`restartPolicy: Never`), and the reconciler failed the
session with `failure:guest_exited`. A session that had reached `READY` had
already been paid for; the refund policy does not compensate a session that
delivered service, so the customer lost the rest of the lease. ADR 0008 recorded
guest-side reconnect as the follow-up that would fix this.

The constraint that made it a protocol change rather than a retry loop is the
single-operation slot. A frame the old relay accepted and the guest never
answered may have started; it must not be executed twice, and its outcome cannot
be invented. Closing that needs the existing execution-epoch fence, not a second
one.

## Decision

Three changes, one per hop:

1. **Guest.** A relay link loss cancels and kills the in-flight operation, then
   reconnects with bounded backoff until the lease ends. It re-sends `hello`
   with the same session id, client nonce, ephemeral key and token, then
   republishes its status (idle, surviving epoch high-water mark). Responses are
   bound to the link the request arrived on, so an aborted operation can never
   answer on the next link. The workspace, open streams and customer services
   are untouched. It exits only on lease expiry, an explicit shutdown, or a
   `401` at the WebSocket handshake (a token retrying cannot fix).
2. **Relay.** A re-registration on a new process generation is an ordinary
   `POST /internal/register` with the token hash minted at create time; the
   shard claim and hash checks are unchanged. A new socket clears the execution
   status reported on the previous one, so a fence never trusts a dead link's
   report. Pending frames are not replayed: they are dropped with the old link
   and stay `outcome_unknown`.
3. **Controller.** Relay recovery compares the generation in the per-session
   snapshot with the last one it observed. On a change (or a registration that
   disappeared) it marks the in-flight request `outcome_unknown` and bumps
   `sessions.exec_epoch` in one guarded transaction (`pending ->
   outcome_unknown` is the guard, so this is exactly once), re-registers the
   session, and tells `OperationFence` to hold the gate until the reconnected
   guest reports its slot idle. A guest that does not come back inside
   `RELAY_LOSS_GRACE_MS` (default 90 s) ends the session with
   `failure:relay_lost`.

The epoch floor is republished to the replacement relay before the fence may
release, so a frame from the superseded generation is still refused, and a retry
of the interrupted request id is `409 outcome_unknown` from the request row.

## Consequences

- A relay restart no longer kills a paid session. The lease, the Pod, the
  workspace and the shard's reservations are unchanged; the next operation is
  admitted after the reconnected guest reports idle.
- The interrupted operation is never reported as success or failure. Its retry
  is a defined `409 outcome_unknown`, and a new request id runs normally.
- A guest that cannot reconnect is now a distinct outcome
  (`failure:relay_lost`) instead of looking like a crashed guest
  (`failure:guest_exited`). The refund policy can treat it separately; this
  change only produces the reason.
- Re-registration replays no credential: the token hash on the session row is
  reused. A create retry that already booted a pod therefore adopts it before
  `register_relay` can mint a new token, or the running guest would be locked
  out.
- A reset for a withdrawn stale frame (ADR 0008) is now also a reconnect: the
  session survives and the stale frame still never starts.
- Cost: the supervisor has a reconnect loop that must be bounded, and the
  controller has one more per-session scan (housekeeping cadence) whose snapshot
  is the relay generation.

## Residual windows

- **Detection lag.** Relay recovery runs on the housekeeping timer (1 s). Between
  the relay dying and the scan noticing, a new operation can be claimed with the
  old epoch and then fail at the relay (`409 guest_not_available`) because the
  registration is gone. It is never executed twice and the client retries.
- **An unreachable relay also starts the grace.** The scan cannot tell "the
  relay was replaced" from "the control plane is stalled", so a relay that does
  not answer for `RELAY_LOSS_GRACE_MS` ends live sessions with `relay_lost`. The
  trade-off is deliberate: the alternative is to keep consuming a paid lease
  that cannot do any work, with no distinct reason for the refund policy. A
  pause shorter than the grace (the fault matrix uses 3 s) is absorbed, and the
  grace is configurable.
- **Fence release on a same-relay reset.** When the relay withdraws a frame by
  resetting the socket and no generation change follows, the fence may release
  on the disconnected branch, before the guest reconnects. That is sound, because
  the link loss aborts the command, but a new operation in that window fails with
  `guest_not_available` rather than waiting for idle.
- **Controller restart while the relay also restarted.** Startup recovery fences
  and bumps the epoch, but the in-memory reconnect hold is empty, so the fence
  may release on the disconnected branch. The old command is aborted by the
  link loss, so this remains the ADR 0008 argument rather than a new gap.
- **Observed frame.** A frame the guest has already read before the link died may
  start. It is the ADR 0008 residual; the fence waits for it and the relay never
  re-delivers it.

## Alternatives considered

- **Keep the Pod alive without restoring the protocol.** Rejected: the guest
  would have no relay, every operation would fail, and the payer would keep
  paying for an unreachable sandbox.
- **Redeliver the pending frame after reconnect.** Rejected: the guest may
  already have started it, so this is duplicate execution. The outcome is
  unknown and only a client retry with a new request id is safe.
- **A persistent relay registry.** A different deployment (shared store,
  sticky routing), and it would still not survive the guest's socket dropping.
  The reconnect path is needed either way.
- **Fail the session and refund it.** Simpler, but it ends a paid session for an
  infrastructure restart the customer did not cause, and a partial refund is a
  policy question this path only has to make answerable.
