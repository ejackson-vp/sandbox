# Lifecycle: images, suspend, resume

Status: **implemented in dev/local and on the kind cluster.** This is a
filesystem checkpoint, not a Firecracker memory snapshot. The contract is
inspired by AWS Lambda MicroVMs; the storage and isolation model is deliberately
different.

## Contract

| Noun | x402 | Lambda MicroVMs analogue |
|---|---|---|
| `image` | operator-pinned guest image + digest (`GET /v1/images`) | MicroVM image version |
| `run` | `POST /v1/sessions` | `run-microvm` |
| `suspend` | `POST /v1/sessions/{id}/suspend` | `suspend-microvm` |
| `resume` | `POST /v1/sessions/{id}/resume` | `resume-microvm` |
| `terminate` | `DELETE /v1/sessions/{id}` | `terminate-microvm` |
| `idlePolicy` | `maxIdleSeconds`, `suspendedDurationSeconds`, `autoResume` | same shape |
| `maxDuration` | `maxLifetimeSeconds` (≤ 8 h) | `maximum-duration-in-seconds` |
| `run hook payload` | claim frame (session config) | `runHookPayload` |

The wire format is x402-native: a capability, not an AWS JWE or IAM role. The
lifecycle vocabulary is shared so an adapter is possible, but exact AWS
compatibility is not a goal.

## State machine

```
PAID ──pod──► PROVISIONING ──hello──► READY ⇄ ACTIVE
  │                                     │
  │                                     ├── idle policy ──► SUSPENDED
  │                                     │                    │
  │                                     │                    └── resume ──► PROVISIONING
  └── lease / destroy / failure ──► TERMINATING ──► EXPIRED | FAILED | DESTROYED
```

`SUSPENDED` is not usable. `leaseExpiresAt` is `null` while suspended; a resume
starts a fresh lease of the purchased duration. `maxLifetimeSeconds` is a
wall-clock cap that includes suspended time.

## What suspend actually does

1. The controller sends a `shutdown`/`suspend` notice to the guest.
2. The guest kills its process group and exits.
3. The controller deletes the **pod** but keeps the per-session **workspace PVC**.
4. The relay entry is purged; the session is marked `SUSPENDED`.

Resume:

1. The controller creates a new pod with the same PVC and a fresh relay token.
2. A new guest process boots with a **fresh keypair** and fresh evidence.
3. The SDK `resume()` waits for READY, verifies the new evidence, and updates
   `handle.guestPublicKey` before sending any operation.
4. The workspace (files) is exactly as it was; processes, memory, open sockets
   and in-memory caches are gone.

This is the key difference from AWS: Lambda MicroVMs restore **memory and disk**
from a snapshot. x402 restores disk only. It is enough for notebooks, files and
installed packages; it is not enough to keep a running server or an in-memory
job alive across suspend.

## Security properties

- **Workspace at rest:** suspendable sessions use a PVC, not a memory-backed
  `emptyDir`. The workspace is therefore readable by the node/storage
  administrator, and at-rest encryption depends on the StorageClass. Use an
  encrypted StorageClass in production.
- **No controller plaintext:** the controller creates and deletes the PVC but
  never mounts or reads it. The guest is the only reader/writer.
- **No reuse:** the PVC is per session and deleted on terminate / max lifetime;
  it is never handed to another session.
- **Fresh keys on resume:** the new guest generates a new keypair; the old
  private key is gone with the pod. The client capability is payment-bound and
  remains valid, but the client must refresh the guest public key (the SDK does).
- **Capability lifetime:** for suspendable sessions the capability TTL is based
  on `maxLifetimeSeconds`, not the first lease, so a resume hours later still
  works.
- **Relay state:** the suspended session has no relay entry; resume registers a
  new one and purges it on terminate.

## Limits and caveats

- A suspendable session is **not eligible for the warm pool**: the warm pod's
  volumes are fixed at creation, and a checkpointed session needs its PVC.
  Across three kind runs: first READY 4.3–5.8 s, suspend 21–23 ms, resume
  0.86–1.90 s. These are smoke measurements, not a distribution.
- Suspend is fast because it is a pod delete plus a wait for the pod to vanish;
  in a busy cluster the wait dominates.
- `maxLifetimeSeconds` defaults to 8 h for suspendable sessions; the maximum is
  8 h. Suspended time counts toward it.
- `autoResume` is advisory today: the server returns `409 session_suspended` and
  the client must call `resume()`. A future client can honor the hint
  automatically.
- There is no server-side memory snapshot, no `/suspend` hook that flushes
  application state, and no prefetch/validate hook for the image. Those require
  KVM/Firecracker or Kata/CRIU and a real image build pipeline.
- Suspend/resume is currently free in the mock payment model. A production
  product must decide whether to bill active time, resumes, or storage; the
  current lease restarts on resume.

## API

```http
POST /v1/sessions/{id}/suspend
x-sandbox-capability: ...
→ 200 { state: "SUSPENDED", suspendedAt, resumeCount, ... }

POST /v1/sessions/{id}/resume
x-sandbox-capability: ...
→ 202 { state: "PROVISIONING", ... }   # poll / wait for READY

GET /v1/images
→ { images: [{ id, digest, reference, runtimeClass, executionMode, current }] }
```

Creating a suspendable session:

```json
{
  "tier": "custom",
  "durationSeconds": 60,
  "cpuMillis": 1000,
  "memoryMiB": 1024,
  "diskMiB": 512,
  "clientPublicKey": "...",
  "clientNonce": "...",
  "idlePolicy": { "maxIdleSeconds": 300, "suspendedDurationSeconds": 28800, "autoResume": true },
  "maxLifetimeSeconds": 28800
}
```

Operations against a suspended session return `409 session_suspended`; resume
first.

## Kubernetes implementation

- PVC name: `x402-ws-<session-id>`; StorageClass from
  `WORKSPACE_STORAGE_CLASS` (default `standard`).
- The controller has `create/get/list/delete` on `persistentvolumeclaims`.
- The pod mounts the PVC at `/workspace` instead of the memory `emptyDir`.
- `fsGroup: 65532` makes the volume writable by the unprivileged guest.
- The PVC is deleted when the session is terminated or its lifetime expires.

## AWS comparison

| | x402 checkpoint | Lambda MicroVMs |
|---|---|---|
| Boot | container + guest (~1.9 s resume) | Firecracker snapshot restore (~1–2 s independent) |
| State | disk/PVC only | memory + disk + FDs |
| Idle cost | PVC storage | snapshot storage |
| Max state | 8 h wall clock | 8 h |
| Isolation | pod; Kata/TEE deferred | Firecracker/KVM |
| Endpoint | relay + capability | per-VM HTTPS + JWE |
| Payments | x402, accountless | IAM/account |
| Control plane plaintext | never | AWS is the operator |

The practical lesson from Lambda MicroVMs is the **contract and the economics**,
not the wire format: a suspendable session with cheap idle and a fast resume is
a better product for agents than a 30-minute lease. The local implementation
proves the control-plane semantics; memory snapshots remain a KVM follow-up.
