# 0003. The guest dials out to a relay; there is no ingress

Status: accepted

## Context

A sandbox that accepts inbound connections has an attack surface that grows with
every exposure: a port, a service, a proxy, a certificate, a NetworkPolicy that
someone will eventually relax. The sandbox also has to be reachable from the
control plane to receive commands, which is the same problem in the other
direction.

## Decision

Sandbox pods have no ingress rules. The guest opens one outbound WebSocket to the
session relay, authenticates with a token whose hash the controller stores, and
signs a statement binding its ephemeral key to the session id, nonce and client
key. The relay correlates opaque request/response frames by id and cannot reach
internal services itself.

## Consequences

- There is no inbound path to attack: the pod is unreachable by construction,
  which is stronger than a policy that can be edited.
- Every operation needs a live guest connection. If the guest is not connected,
  work queues or fails; there is no store-and-forward path.
- Network isolation is testable at the packet level, and the security suite does
  exactly that.
- No SSH. Operators debug through the same API the customer uses, or through pod
  logs that contain no plaintext.

## Alternatives considered

- **SSH or `kubectl exec` into the pod.** Familiar, and immediately gives away
  the isolation property: the control plane needs a path in.
- **Ingress with mTLS.** Moves the problem rather than removing it, and every
  certificate and policy is another thing to get wrong.
- **A generic reverse tunnel (e.g. an off-the-shelf proxy).** Operationally
  heavier than a frame switch, and usually includes features that can reach
  internal services.
