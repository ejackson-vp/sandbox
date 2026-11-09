# 0006. The lease is immutable and enforced in three places

Status: accepted

## Context

A leased sandbox is only meaningful if the lease actually ends. A controller
that grants extensions, or that is the only component enforcing the deadline,
turns every clock skew, restart and bug into a free session. The client also has
to be able to reason about the deadline without trusting the API response.

## Decision

The deadline is fixed when the session reaches `READY` and is not extendable.
Three independent mechanisms enforce it:

1. the guest watchdog, which stops work in the VM;
2. the controller deadline, which deletes the pod and purges relay state;
3. Kubernetes `activeDeadlineSeconds`, which terminates the pod even if the
   controller is down.

Any one of them is sufficient. The client sees the same timestamp in the session
status and can stop before it.

## Consequences

- No single bug or restart extends a lease.
- Deadline logic is deliberately duplicated, so the three mechanisms must be kept
  consistent. Changing one without the others is a bug, not a refactor.
- Long-running work needs checkpointing and a new session rather than an
  extension. That is a product constraint, not an implementation detail.
- Clock skew between components shortens sessions rather than lengthening them,
  which is the safe direction.

## Alternatives considered

- **Controller-only enforcement.** Simplest, and the first thing that fails
  during a controller outage.
- **Renewable leases.** Better for long jobs, but it makes cost unbounded and
  turns a settled payment into an open tab.
- **Client-side timers.** Not a security boundary.
