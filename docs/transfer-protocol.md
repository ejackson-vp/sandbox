# Streaming transfer protocol

## Existing path

The legacy `file.put` / `file.get` operations carried the entire file in one
sealed envelope. The API envelope cap, the guest `Workspace.Put/Get` 8 MiB
limit, and the 16 MiB request schema were the hard ceiling.

The streaming path reuses the same transport:

```
SDK sealed operation -> API -> controller -> relay -> guest supervisor
guest sealed result  <- API <- controller <- relay <- supervisor
```

Each chunk is a separate operation and envelope. The API, controller and relay
remain opaque to content.

## Operations

| Operation | Fields | Effect |
|---|---|---|
| `transfer.init` | `transferId`, `direction`, `path`, `size?`, `chunkSize` | Create staging/open source; return committed offset and download digest |
| `transfer.chunk` | `transferId`, `offset`, `dataBase64` | Append one authenticated upload chunk |
| `transfer.complete` | `transferId`, `size`, `digest` | Verify size + SHA-256, fsync, atomically rename staging to destination |
| `transfer.status` | `transferId` | Return state and committed bytes |
| `transfer.read` | `transferId`, `offset`, `maxBytes` | Return the next download chunk |
| `transfer.cancel` | `transferId` | Close and delete staging |

A transfer id is client-generated and bound to the session by the existing
sealed operation (`sessionId`, `clientNonce`, request id). Chunks for a
different transfer/path are rejected.

## States

```
TRANSFERRING -> VERIFYING -> COMPLETED
      |              |
      +-> CANCELLED  +-> FAILED
      +-> EXPIRED (10 minute idle TTL)
```

## Flow control

The guest accepts exactly one operation per session at a time, and the SDK sends
one chunk and waits for its ACK. This is **window = 1**. It is deliberate:
backpressure comes from the existing request/response transport rather than a
second queue. There is no unbounded in-flight chunk list in SDK, relay or guest.

A future window >1 needs a transfer-specific concurrent operation path; the
current session slot intentionally serializes operations.

## Resume

- Upload: `transfer.init` with the same `transferId` returns the durably written
  offset. The SDK seeks and continues. Staging never appears at the destination.
- Download: the guest returns a source digest and current offset. The SDK checks
  the local `.x402-part-<id>` size against that offset and resumes only on a
  match. Source size/mtime changes return `source_changed`.
- Client disconnect: guest stays alive and keeps staging/state for the TTL.
- Guest/relay/sandbox restart: not resumable; the guest transfer table is in
  memory and the staging workspace is lost with the pod. The SDK fails
  explicitly; no distributed storage is introduced.

## Atomic publication

Uploads write to `<workspace>/.tmp/xfers/<transferId>`, fsync, verify final
length and SHA-256, then `rename` to the destination. Rename on the same
filesystem is atomic. A failed/cancelled/expired upload leaves no destination
file. Concurrent uploads to the same path are rejected with `path_busy`.

## Limits

| Limit | Default |
|---|---:|
| Legacy per-message file | 8 MiB |
| Streaming transfer | 256 MiB (`MAX_TRANSFER_BYTES`) |
| Chunk size | 64 KiB–1 MiB; SDK default 512 KiB; 1 MiB requires the 2 MiB envelope budget |
| Concurrent transfers per session | 4 |
| Staging TTL | 10 minutes |
| Workspace disk | session `diskMiB` (default 256 MiB) |
| In-flight chunks | 1 |
