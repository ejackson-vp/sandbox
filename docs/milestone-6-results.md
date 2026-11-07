# Milestone 6 results: streaming transfers and large artifacts

Status: measured on the local kind rig with the stock guest image. Mock x402
payments; synthetic data only. No security control was relaxed.

## A. Compatibility

| Transfer | Works? | Limit |
|---|---|---|
| 1 KiB | Yes | streaming overhead visible |
| 1 MiB | Yes | 2 chunks |
| 8 MiB | Yes | 16 chunks; legacy path also works |
| 32 MiB | Yes | 64 chunks |
| 100 MiB | **Yes** | 200 chunks, SHA-256 verified both directions |
| 256 MiB | Yes (opt-in stress) | 512 chunks, SHA-256 verified |
| Upload/download resume after client disconnect | Yes | same transfer id; guest stays alive |
| Cancellation | Yes | `transfer.cancel` removes staging |
| Directory archive streaming | **Yes** | 80-file synthetic tree round trip; upload extracts to a temporary directory; destination must not already exist |
| Resume after guest/relay restart | **No** | fails explicitly; no distributed storage |
| 1 MiB chunk | **Yes** | requires the 2 MiB sealed-envelope budget; default remains 512 KiB |

The Milestone 5 Python workload was upgraded to a **102.45 MiB, 6,000,000-row
CSV** and completed end to end:

- session ready 1.60 s,
- upload 7.33 s (13.99 MiB/s),
- pandas install 5.22 s,
- Python grouping/filtering 1.69 s,
- verified 3,000,000 filtered rows,
- downloaded a 51.54 MiB filtered artifact in 3.57 s,
- total 19.7 s, workspace used 340 MiB.

Partial uploads never appear at the destination. Completion requires matching
size and SHA-256, then an atomic rename.

## B. Performance

512 KiB chunks, public SDK, local kind:

| Size | Upload | Download | First byte | Chunks |
|---:|---:|---:|---:|---:|
| 1 KiB | ~17 ms | 17 ms | 16 ms | 1 |
| 1 MiB | 113 ms (8.86 MiB/s) | 65 ms (15.37 MiB/s) | 37 ms | 2 |
| 8 MiB | 561 ms (14.26 MiB/s) | 534 ms (14.97 MiB/s) | 37 ms | 16 |
| 32 MiB | 2,069 ms (15.46 MiB/s) | 1,710 ms (18.71 MiB/s) | 88 ms | 64 |
| 100 MiB | **6,199 ms (16.13 MiB/s)** | **5,252 ms (19.04 MiB/s)** | 79 ms | 200 |
| 256 MiB | 16,061 ms (15.94 MiB/s) | 12,810 ms (19.98 MiB/s) | — | 512 |

Chunk-size sweep at 32 MiB:

| Chunk | Upload | Download |
|---:|---:|---:|
| 64 KiB | 6.86 MiB/s | 7.40 MiB/s |
| 256 KiB | 13.43 MiB/s | 14.91 MiB/s |
| 512 KiB | **16.28 MiB/s** | **18.36 MiB/s** |

Window>1 pipelining was probed separately:
[docs/transfer-pipelining-probe.md](transfer-pipelining-probe.md). The stack is
near a 20–24 MiB/s per-byte ceiling, and an ideal window of 8 projects only
1.18–1.33× at 1 MiB chunks, so the protocol complexity is not justified yet.

Memory:

- SDK chunks are read/written one at a time; no whole-file buffer.
- Node RSS deltas were noisy (1 MiB +34.8 MiB, 8 MiB +81.9 MiB, 32 MiB
  -22.6 MiB, 100 MiB +21.4 MiB). GC and stream buffers make RSS a poor
  steady-state metric without forced GC.
- Guest cgroup peak grows with file size because the local workspace is a
  memory-backed `emptyDir`: 100 MiB input ⇒ ~123 MB guest peak. This is
  workspace storage, not a whole-file supervisor copy. A disk-backed workspace
  would change the curve.
- Relay memory was not instrumented; it forwards one sealed operation at a time.
- No component buffers a whole large file.

## C. Reliability

Tested with `examples/transfer-faults.ts`:

| Fault | Result |
|---|---|
| Upload interrupted at 10 MiB | destination absent; resume with transfer id completed |
| Download interrupted at 10 MiB | `.x402-part-*` retained; resume from acknowledged offset completed |
| Cancellation | `transfer_cancelled`; staging removed |
| Quota (16 MiB disk) | `quota_exceeded` |
| Duplicate chunk | acknowledged without rewriting |
| Out-of-order chunk | `out_of_order` |
| Path traversal | `invalid_path` |
| Concurrent upload to same path | `path_busy` |
| Incomplete upload visible | no |
| Download source mutation | detected by size/mtime check (`source_changed`) |

Not automated end-to-end: relay restart mid-transfer, guest process restart,
session expiry mid-transfer, and download source mutation with a deliberate
pause. Guest transfer state is in memory, so guest/relay restart is explicitly
non-resumable.

## D. Security

- Every chunk is an existing X25519 sealed-box operation; no custom crypto.
- Chunk binding: session id/client nonce/request id from the envelope, plus
  transfer id, direction, offset and transfer state in the guest.
- AEAD protects each chunk; full-file SHA-256 protects the assembled result.
- Paths are resolved in the existing workspace sandbox; staging and source
  files use `O_NOFOLLOW`.
- Upload staging is under `.tmp/xfers`; completion fsyncs, verifies, then
  atomically renames. Failed/cancelled uploads are removed.
- Workspace disk quota and transfer size limits cover staging.
- Control plane sees opaque envelopes only; logs contain ids, direction and
  byte counts, not paths/content.
- No Pod security, Cilium policy, relay-only ingress or capability checks were
  weakened.

Caveats:

- The local workspace is memory-backed; 100 MiB file storage counts toward guest
  memory.
- The session capability authorizes transfers like any other operation; there
  is no separate transfer capability.
- The sealed-envelope budget is now 2 MiB to support an optional 1 MiB chunk;
  the default remains 512 KiB. This increases per-operation memory by ~1 MiB.

## E. SDK experience

100 MiB upload/download requires no manual splitting:

```ts
let sandbox;
try {
  sandbox = await client.create({ durationSeconds: 300, cpuMillis: 1000, memoryMiB: 1024, diskMiB: 1024 });
  await sandbox.upload("./dataset.bin", "/workspace/dataset.bin", {
    onProgress: (p) => console.log(p.bytesTransferred),
  });
  await sandbox.download("/workspace/result.bin", "./result.bin");
} finally {
  await sandbox?.destroy();
}
```

`TransferOptions` adds `onProgress`, `signal`, `timeoutMs`, `chunkSize` and
`transferId` for resume. The facade automatically selects streaming above the
legacy 8 MiB file limit.

## F. Bottleneck analysis

Measured limits:

- 512 KiB is the default; 1 MiB improves 32 MiB upload/download to 16.93/19.06
  MiB/s, but needs the 2 MiB envelope budget. 64 KiB loses to round-trip overhead.
- Throughput plateaus at ~16 MiB/s up / ~19 MiB/s down. Each chunk is one
  controller→relay→guest→relay→API round trip; window is 1.
- API read limiter was raised from 600/40 to 2400/200 burst/refill to avoid
  self-throttling a legitimate transfer; that is a real coupling that must be
  documented.
- Guest workspace is tmpfs, so guest peak memory tracks file size. This is the
  next memory limitation after protocol buffering is removed.
- Relay memory was not instrumented; no evidence of whole-file buffering.

## G. Remaining gaps

- Directory archive publication requires a new destination; replacing an existing directory is rejected to avoid partial merges.
- Archive uploads/downloads are streamed but use the host/SDK `tar` command for creation/extraction.
- No in-flight window >1; no ACK batching.
- No resume after guest/relay restart; no durable staging metadata.
- No transfer-specific capability or byte-level controller metrics
  (`bytes_total`, `inflight_bytes`, `staging_bytes` are not emitted).
- 1 MiB chunks increase envelope memory; they are opt-in, not the default.
- 256 MiB works as an opt-in stress; local tmpfs memory is the practical limit.
- Source-mutation detection is per read; no test with a deliberately changing
  source.

## H. Recommendation

The single most valuable next experiment is **bounded pipelining**: allow a
small in-flight window (2–4 chunks) with batched ACKs, while keeping per-session
byte and memory caps. The one-chunk round trip is the measured bottleneck:
64 KiB is worse, 512 KiB is the default, and 1 MiB improves 32 MiB throughput
only modestly while costing a 2 MiB envelope. Pipelining addresses the
round-trip limit without another global memory increase.

Do not add distributed storage, Firecracker/Kata, autoscaling or a new queue to
solve this.

## Reproduction

```bash
make up
make demo-large-file
make benchmark-transfers
make benchmark-transfer-stress
npx tsx examples/transfer-faults.ts
make test-transfers
```

## Verification

- Full suite: **158 passed, 3 skipped** (transfer additions included; final run below)
- `make demo-directory`: 80 files round trip verified
- 102.45 MiB Python workload: grouped/filter validated, 51.54 MiB artifact downloaded
- 100 MiB and 256 MiB binary round trips verified
- Go guest tests: pass, including transfer ordering, path busy, atomic publish
- `make demo-large-file`: 100 MiB round trip, matching SHA-256
- 256 MiB stress: matching SHA-256
- `examples/transfer-faults.ts`: upload/download resume, cancellation, quota
- `make benchmark-transfers`: size and chunk-size sweep
- Cluster clean after demos; security policies unchanged
