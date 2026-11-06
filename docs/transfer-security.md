# Streaming transfer security

## Encryption and authentication

Each chunk is a normal X25519 sealed-box operation, using the existing
`envelope.Seal/Open` construction. There is no custom cryptography:

- fresh libsodium sealed-box encryption per chunk,
- chunks are bound through the envelope to session id, client nonce, request id
  and the guest's operation slot,
- the guest additionally binds the chunk to `transferId`, direction and byte
  offset,
- reordered, missing, overlapping or duplicate chunks are rejected or safely
  acknowledged; final SHA-256 decides completion.

Full-file SHA-256 is separate from chunk authentication:

- upload: client sends the digest, guest computes it incrementally and verifies
  before atomic publication,
- download: guest hashes the source at init; client verifies the completed local
  file against it.

The control plane never sees plaintext chunks, paths or content. It sees only
opaque envelopes and transfer operation counts.

## Filesystem protections

- All paths go through `Workspace.Resolve`, which rejects `..`, absolute escapes
  and symlinked parents.
- Upload staging is under `.tmp/xfers`, opened with `O_NOFOLLOW`.
- Download sources are opened with `O_NOFOLLOW`; symlinks and non-regular files
  are rejected.
- Upload publication re-resolves the destination, rejects a directory target,
  then `rename`s; it never writes through a destination symlink.
- Archives remain subject to the existing extraction protections (absolute
  paths, `..`, links, device nodes, entry count, member size).
- Concurrent uploads to the same path are rejected.
- Workspace quota is checked at init and enforced by the filesystem operations.

## Quotas and cleanup

- Transfer init checks declared size against `MAX_TRANSFER_BYTES` and workspace
  `MaxDiskBytes`.
- Staging files count toward workspace usage.
- Cancel, failure, expiry and supervisor shutdown close and delete staging.
- Session pod deletion removes the workspace; a suspended checkpoint retains
  only the workspace, not active transfer state.

## Limits and caveats

- The local workspace for non-suspendable sessions is memory-backed `emptyDir`;
  a 100 MiB file therefore consumes guest memory/page cache as well as logical
  disk quota. This is a local-runtime limitation.
- No transfer-specific capability exists yet: the session capability authorizes
  the operation, and the sealed envelope carries the transfer id. A stolen
  session capability can still authorize transfers, as with any other operation.
- No plaintext paths or content are logged; transfer logs contain only ids,
  direction, byte counts and state.
- The sealed-envelope budget is 2 MiB so an opt-in 1 MiB chunk fits. This is a
  bounded per-operation allocation, not an unbounded file buffer.
