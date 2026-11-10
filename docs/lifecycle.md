# Lifecycle: images, suspend, resume

Status: **implemented in dev/local and on the kind cluster.** This is a
filesystem checkpoint, not a Firecracker memory snapshot. The contract is
inspired by AWS Lambda MicroVMs; the storage and isolation model is deliberately
different: a checkpoint is a filesystem snapshot on a per-session volume, not a
memory snapshot, so a resume is a cold start with a warm disk.

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

```text
PAID ──pod──► PROVISIONING ──hello──► READY ⇄ ACTIVE
  │                                     │
  │                                     ├── idle policy ──► SUSPENDING
  │                                     │                    │ guest stopped
  │                                     │                    ▼
  │                                     │                 SUSPENDED
  │                                     │                    │ resume
  │                                     │                    ▼
  │                                     │                 RESUMING ──hello──► READY
  └── lease / destroy / failure ──► TERMINATING ──► EXPIRED | FAILED | DESTROYED
```

`SUSPENDING` and `RESUMING` are real, observable states. A controller crash
between `markSuspending` and `markSuspended` is repaired by the reconciler;
`RESUMING` continues the normal readiness handshake. `SUSPENDED` is not usable.
`leaseExpiresAt` is `null` while suspended or resuming; a resume starts a fresh
lease of the purchased duration. `maxLifetimeSeconds` is a wall-clock cap that
includes suspended time.

## What suspend actually does

1. The controller moves the session to `SUSPENDING` (atomic, from `READY`/`ACTIVE`).
2. The controller sends a `shutdown`/`suspend` notice to the guest.
3. The guest kills its process group and exits.
4. The checkpoint adapter (`Snapshotter.capture`) is called. The local adapter
   is a no-op because the workspace PVC *is* the checkpoint.
5. The controller deletes the **pod** but keeps the per-session **workspace PVC**.
6. The relay entry is purged; the session is marked `SUSPENDED`.

Resume:

1. The controller checks lifetime, suspended expiry, PVC existence and node
   affinity, then calls `Snapshotter.restore` (no-op locally).
2. The controller creates a new pod with the same PVC and a fresh relay token,
   and marks the session `RESUMING`.
3. A new guest process boots with a **fresh keypair** and fresh evidence.
4. The SDK `resume()` waits for READY, verifies the new evidence, and updates
   `handle.guestPublicKey` before sending any operation.
5. The workspace (files) is exactly as it was; processes, memory, open sockets
   and in-memory caches are gone.

This is the key difference from AWS: Lambda MicroVMs restore **memory and disk**
from a snapshot. x402 restores disk only. It is enough for notebooks, files and
installed packages; it is not enough to keep a running server or an in-memory
job alive across suspend.

## Node affinity and portability

A checkpoint on a local-path PVC is **node-pinned**: the PV only exists on the
node where the first pod ran. The controller records that node, adds a
`metadata.name` node affinity on resume, and checks the node is Ready and
schedulable before creating the pod. If the node is cordoned or gone, resume
fails fast with `409 resume_unavailable` instead of leaving a Pending pod for
the 90 s provisioning timeout.

`make demo-portability` proves it locally: create → write → suspend → cordon the
worker → resume returns `resume_unavailable`; uncordon → resume lands on the
same node with the workspace intact. On the two-worker rig (`make up-2w`) the
session landed on `x402-sandbox-worker2`, was cordoned there, failed fast, then
resumed on worker2 after uncordon — the affinity, not single-node luck, is what
pins it. Set `PIN_CHECKPOINT_NODE=false` when using RWX/network storage, where
pinning is unnecessary.

The two-worker rig is for scheduling/portability tests; the density and
workload harness assumes a single worker, so return with `make down up` before
running those benchmarks.

Production consequence: **a checkpoint cannot survive its node.** For node
failure tolerance use RWX/network storage or a real snapshot/restore; the
local-path checkpoint is a single-node feature.

## Fault behaviour

- **Workspace deleted while suspended:** resume checks the PVC exists, marks the
  session `FAILED` with `checkpoint_missing` and returns `409 resume_unavailable`.
  It does not create a pod against a missing volume.
- **Controller restart while suspended:** the session is in SQLite and the PVC is
  untouched; the restarted controller resumes it and the workspace is intact.
- **Relay restart while suspended:** covered by the lifecycle soak; resume
  registers a fresh relay entry.
- **Node cordoned/gone:** `409 resume_unavailable` (see portability above).

`make demo-faults` exercises the missing-PVC and controller-restart cases.

## Security properties

- **Workspace at rest:** suspendable sessions use a PVC, not a memory-backed
  `emptyDir`. A suspended workspace is **plaintext**: the node and storage
  administrators can read it, and no encryption at rest is provided by this
  repository or by the homelab's `local-path` `standard` StorageClass. See
  [ADR 0007](adr/0007-checkpoint-at-rest-plaintext.md) for why an encrypted
  StorageClass is not claimed as a guarantee, and
  [Checkpoint at rest, expiry and backup](#checkpoint-at-rest-expiry-and-backup)
  for the exact boundary.
- **No controller plaintext:** the controller creates and deletes the PVC but
  never mounts or reads it. The guest is the only reader/writer.
- **No reuse:** the PVC is per session and deleted on terminate, suspended
  expiry or max lifetime; it is never handed to another session. A PVC that no
  session owns is reaped after a grace period.
- **Fresh keys on resume:** the new guest generates a new keypair; the old
  private key is gone with the pod. The client capability is payment-bound and
  remains valid, but the client must refresh the guest public key (the SDK does).
- **Capability lifetime:** for suspendable sessions the capability TTL is based
  on `maxLifetimeSeconds`, not the first lease, so a resume hours later still
  works.
- **Relay state:** the suspended session has no relay entry; resume registers a
  new one and purges it on terminate.

## Checkpoint at rest, expiry and backup

Status: **plaintext, no encryption.** This is the exact boundary; see
[ADR 0007](adr/0007-checkpoint-at-rest-plaintext.md) for the decision and the
rejected alternatives.

What the checkpoint is:

- A suspendable session's `/workspace` is a per-session PVC (`x402-ws-<id>`) on
  `WORKSPACE_STORAGE_CLASS` (default `standard`). The PVC *is* the checkpoint;
  there is no separate snapshot object and no copy.
- The controller creates, checks and deletes the PVC. It never mounts it, so the
  controller, API, relay, SQLite database and their logs never hold the
  checkpoint's contents.
- The guest is the only reader/writer, and only while a pod is running. When the
  pod is gone, nothing in this system can read the files except whoever controls
  the storage backend.

What that means:

| Question | Answer |
| --- | --- |
| Is a suspended workspace encrypted at rest? | No. Not by the guest, not by the controller, not by `local-path`. |
| Who can read it? | The node administrator, the storage administrator, anyone who can read the node's filesystem or copy the volume, and any backup of that volume. |
| Does the controller hold a key? | No. There is no checkpoint key anywhere in the control plane. |
| Is it protected by the StorageClass? | No class in this repository provides encryption. An encrypted CSI class, where one exists, protects a detached disk against a third party — not against the node admin — and the controller does not verify it. |
| Is it in the SQLite backups (`BACKUP_DIR`)? | No. Backups contain session metadata only; a restore does not restore workspaces. |
| Is it ever reused by another session? | No. One PVC per session; never relabelled or handed on. |

Retention and expiry:

| End of life | Mechanism |
| --- | --- |
| Client destroy | `DELETE /v1/sessions/{id}` → terminate → PVC deleted |
| Max lifetime (`maxLifetimeSeconds`, default and maximum 8 h) | `EXPIRED` → terminate → PVC deleted |
| Suspended expiry (`idlePolicy.suspendedDurationSeconds`, default 8 h) | `EXPIRED` → terminate → PVC deleted |
| Terminal state reached but cleanup interrupted | `Lifecycle.cleanup` deletes every terminal session's recorded PVC each housekeeping tick |
| Session row lost (database restore, manual deletion) | Orphan-PVC sweep deletes a labelled workspace PVC that no session owns after `ORPHAN_PVC_GRACE_MS` (default 1 h) |

The last two rows are backstops, not guarantees: they bound how long an
unclaimed plaintext volume can sit in the namespace, and they run while the
controller is up. If the controller is down, nothing expires. There is no
Kubernetes-level TTL on a PVC.

Operational rules that follow from this:

- Size the suspended window to the data, not the other way round. An 8 h
  default is a product choice, not a security control.
- Do not put a checkpoint on a volume you also use for anything else, and do not
  copy it into a backup or support bundle without treating the copy as
  plaintext.
- If the cluster offers an encrypted CSI class, use it and record that as a
  deployment property; it improves disk-loss exposure and changes nothing about
  the node-admin threat.

## Limits and caveats

- A suspendable session is **not eligible for the warm pool**: the warm pod's
  volumes are fixed at creation, and a checkpointed session needs its PVC.
  Across three kind runs: first READY 4.3–5.8 s, suspend 21–23 ms, resume
  0.86–1.90 s. These are smoke measurements, not a distribution.
- Suspend is fast because it is a pod delete plus a wait for the pod to vanish;
  in a busy cluster the wait dominates.
- `maxLifetimeSeconds` defaults to 8 h for suspendable sessions; the maximum is
  8 h. Suspended time counts toward it. Both suspended expiry and max lifetime
  finalise as `EXPIRED`; an integration test covers a 1 s suspended expiry.
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
→ 202 { state: "RESUMING", ... }       # poll / wait for READY

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
- The housekeeping loop also reaps a `x402.io/pool=workspace` PVC that no
  session owns once it is older than `ORPHAN_PVC_GRACE_MS` (default 1 h). This
  covers a lost session row, not a live controller: if the controller is down,
  nothing expires.

## Measured workspace-size behaviour

Two samples per size (`./scripts/benchmark-lifecycle.sh` in sandbox-bench), 0 / 32 / 256 MiB:

| Workspace | READY p50 | Suspend p50 | Resume p50 | Write p50 |
|---|---:|---:|---:|---:|
| 0 MiB | 4.97 s | 19 ms | 0.86 s | 12 ms |
| 32 MiB | 4.97 s | 29 ms | 0.86 s | 22 ms |
| 256 MiB | 4.75 s | 17 ms | 1.78 s | 65 ms |

Resume is dominated by pod start + PVC bind, not by copying the workspace —
there is no copy. The 256 MiB point is noisier at n=2; a 4× data increase did not
produce a 4× resume. This is the number to compare against a Firecracker
snapshot later.

## Soak

`./scripts/benchmark-lifecycle-soak.sh` (sandbox-bench) runs create → write → suspend → (sometimes
controller/relay restart) → resume → verify → destroy. A 90 s run at 0.5/s:

| Metric | Result |
|---|---|
| Sessions | 12/12 ok, workspace verified 12/12 |
| Suspend | p50 24 ms |
| Resume | p50 1.91 s (p95 2.13 s) |
| Faults | 3/3 recovered (controller/relay restarts) |
| Final state | 0 session pods, **0 workspace PVCs**, 0 relay sessions |

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
