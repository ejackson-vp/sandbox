# 0007. Checkpoint workspaces are plaintext, and stay documented as such

Status: accepted

## Context

Suspend/resume keeps `/workspace` on a per-session PVC (`x402-ws-<id>`) in the
sandbox namespace. The volume is the checkpoint: the pod is deleted, the PVC is
not. That puts a suspended session's files outside the guest's encryption
boundary and inside the node/storage trust domain.

The homelab's `standard` StorageClass is `local-path-provisioner`, which writes
into a directory on the node. There is no CSI driver, no `dm-crypt`, no
encryption parameter, and no key that the guest or the controller holds. Issue 32
asks for "checkpoint data at rest is unreadable without the session key". That is
not true of any mode shipped in this repository, and it cannot be made true by
configuration alone.

The threat is specifically the node/storage administrator, who can already read
guest memory and the node filesystem. An at-rest control that does not remove
that administrator from the trust domain cannot answer the issue as written.

## Decision

1. **Do not claim checkpoint encryption.** `docs/security-guarantees.md`,
   `docs/lifecycle.md`, `docs/threat-model.md` and `docs/production-readiness.md`
   state that a suspended workspace is plaintext and readable by the
   node/storage administrator in both `runc` and Kata modes.
2. **Reject an "encrypted StorageClass" gate as the answer.** With
   cluster-scoped read the controller could inspect a StorageClass object and an
   operator-declared label; it cannot verify that the CSI driver actually
   encrypts, and the PV exposes no such fact. A declared label is configuration
   intent, not a guarantee, and it would fail closed on the homelab where no such
   class exists. An encrypted CSI class remains a valid *deployment* improvement
   for clouds that offer one (it protects a detached disk or a copied volume
   against someone who is not the node admin), and it is documented as such
   rather than enforced.
3. **Reject in-guest LUKS/`dm-crypt` for this supervisor.** `local-path` binds a
   directory, not a raw block device, so there is no device to open; a loopback
   file needs privileged container access and a key in guest memory; and because
   the host can read guest memory, the result still does not answer the
   node-admin threat. It would add a large privileged surface for no guarantee.
4. **Target architecture: client-side encrypted checkpoint objects.** At suspend
   the guest packs the workspace into an authenticated, chunked archive,
   encrypts it with a data key generated inside the guest, wraps that key to the
   client's public key, uploads the ciphertext to object storage, and deletes
   the plaintext PVC. At resume the client supplies the data key inside the
   sealed channel; the guest decrypts into a fresh workspace. The controller and
   the object store never hold a usable key. This is the only design here that
   makes the issue's sentence true, and it is a protocol change, not a config
   change: resume becomes client-present, so unattended `autoResume` cannot
   work; suspend must delete the PVC or the guarantee is void; and resume latency
   gains a download and a decrypt.
5. **Interim, implemented today:** no PVC reuse, deletion on terminate, suspended
   expiry and max lifetime, an orphan-PVC reaper for volumes no session owns,
   and PVCs explicitly excluded from the controller backup corpus.

## What is guaranteed today

| Property | Value |
| --- | --- |
| The controller, API, relay, database and logs hold checkpoint plaintext | No — none mounts the PVC |
| The node/storage administrator can read a suspended workspace | **Yes** |
| Checkpoint encryption at rest | **None** |
| A workspace PVC is ever reused by another session | No |
| A workspace PVC survives session termination | No |
| An unowned workspace PVC survives indefinitely | No — reaped after `ORPHAN_PVC_GRACE_MS` while the controller runs |
| Checkpoint data is in the database backups | No |

## Consequences

- The at-rest exposure of a suspended session is the same as the guest's
  plaintext. Retention and deletion, not cryptography, bound the window.
- Restoring the controller database does not restore any workspace (see
  production-readiness item 13); the checkpoint is a second data store with its
  own availability and retention story.
- A future TEE removes the node-admin read path for *running* memory. It does
  not encrypt a detached PVC, so this decision is independent of attestation.
- The issue's first acceptance criterion is not met and should move to the
  client-side encrypted checkpoint work rather than be closed by this record.

## Follow-ups

1. **Client-side encrypted checkpoints**: archive format, key wrap to the client
   public key, key delivery on resume, guest-side encrypt/decrypt, PVC deletion
   at suspend, object-store adapter behind `Snapshotter`, SDK/CLI resume change.
2. **Storage-level encryption guidance**: a documented CSI class and the
   retention/backup rules for operators who have one, with an explicit statement
   that the controller does not verify it.
3. **Guest filesystem encryption** (as an alternative to object storage): would
   keep the PVC shape but needs a filesystem layer plus key delivery; evaluate
   only if follow-up 1 proves too slow for resume.
4. **Checkpoint durability**: issue #32 is unrelated to replication; the
   encrypted object store is also the natural answer to item 13.

## Alternatives considered

- **Encrypted StorageClass / CSI, enforced at create time.** Unverifiable,
  unavailable here, and aimed at a weaker attacker than the one in the issue.
- **LUKS in the guest.** No block device under `local-path`; key readable by the
  host; large privileged surface.
- **Do nothing and keep the old wording.** Rejected: the wording implied a
  StorageClass fix was sufficient and that the checkpoint was in the encrypted
  path.
- **Client-side encryption of the live PVC in place.** Equivalent to a guest
  filesystem layer, but without removal of the plaintext copy unless the volume
  is destroyed.
