# 0002. The control plane handles ciphertext only

Status: accepted

## Context

The operator runs the API, the controller and the relay. If those components see
commands and file contents, the security claim collapses to "trust us", which is
exactly what a pay-per-session sandbox is supposed to avoid. But the control
plane still has to route work, enforce deadlines, and return results.

## Decision

Every operation is sealed client-side to the guest's ephemeral public key. The
API accepts a single opaque envelope field, the controller stores and forwards
that envelope, and the relay switches frames by request id without parsing them.
Results are sealed back to a client key and decrypted only on the client.

The control plane sees: session id, request id, sizes, timestamps, and lease
state. It does not see command text, file names, file contents, stdout or exit
codes.

## Consequences

- Compromise of the API or controller does not disclose workload contents.
- No server-side auditing, content inspection, or policy on what runs inside.
  Abuse handling has to rely on resource limits and egress control.
- Debugging is harder: support cannot read a failing command.
- The client must hold a key before it can use the session, which raises the
  cost of a trivial `curl` client. The SDK and CLI exist partly for that reason.

## Alternatives considered

- **TLS terminated at the API.** Simple, and gives the operator a clean
  observability story, but makes plaintext available to the operator.
- **Mutual TLS to the guest.** Protects the hop, not the endpoints; the relay
  still terminates.
- **Noise protocol or a double ratchet.** Better forward secrecy, but more
  stateful than a short-lived session needs.
