# Streaming transfer performance

Measured on the local kind rig through the public SDK. Each fixture is generated
outside the timed region; upload and download include sealed operations, relay
round trips and guest disk I/O.

## Size sweep (512 KiB chunks)

| Size | Upload | Upload MiB/s | Download | Download MiB/s | First byte | Chunks | Guest peak |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 KiB | ~17 ms | ~0.06 | 17 ms | 0.06 | 16 ms | 1 | ~11 MB |
| 1 MiB | 113 ms | 8.86 | 65 ms | 15.37 | 37 ms | 2 | ~19 MB |
| 8 MiB | 561 ms | 14.26 | 534 ms | 14.97 | 37 ms | 16 | ~25 MB |
| 32 MiB | 2,069 ms | 15.46 | 1,710 ms | 18.71 | 88 ms | 64 | ~51 MB |
| 100 MiB | 6,199 ms | **16.13** | 5,252 ms | **19.04** | 79 ms | 200 | ~123 MB |
| 256 MiB | 16,061 ms | 15.94 | 12,810 ms | 19.98 | — | 512 | ~279 MB |

The 100 MiB round trip completed with matching SHA-256 in both directions.
Throughput plateaus around 16 MiB/s up and 19 MiB/s down.

## Chunk-size sweep (32 MiB)

| Chunk | Upload MiB/s | Download MiB/s | Chunks | Notes |
|---:|---:|---:|---:|---|
| 64 KiB | 6.86 | 7.40 | 512 | too much round-trip overhead |
| 256 KiB | 13.43 | 14.91 | 128 | good middle ground |
| 512 KiB | **16.28** | **18.36** | 64 | best measured; envelope-safe |

A 1 MiB chunk is not usable with the existing 1 MiB sealed-envelope cap; the
streaming protocol caps chunks at 512 KiB rather than raising the global
envelope limit.

## Memory

- SDK: chunks are read/written one at a time; no whole-file buffer exists. RSS
  measurements are noisy (GC and Node stream buffers): 1 MiB +34.8 MiB,
  8 MiB +81.9 MiB, 32 MiB -22.6 MiB, 100 MiB +21.4 MiB. The code path is
  bounded by chunk size, but Node RSS is not a clean metric without GC control.
- Guest cgroup peak grows with file size because the local workspace is a
  memory-backed `emptyDir`: 100 MiB file ⇒ ~123 MB guest peak. This is storage,
  not a whole-file copy in the supervisor; a disk-backed workspace would change
  the memory curve.
- Relay memory was not instrumented; it forwards one sealed operation at a
  time, so its live buffering is bounded by the envelope rather than file size.
- No component constructs a complete base64 file or waits for all chunks.

## Large Python workload

Milestone 5's Python workload now uses a 102.45 MiB, 6,000,000-row CSV:

| Stage | Result |
|---|---:|
| Session ready | 1.60 s |
| Input upload | 7.33 s (13.99 MiB/s) |
| pandas install | 5.22 s |
| Python grouping/filtering | 1.69 s |
| Filtered artifact download | 3.57 s (51.54 MiB) |
| Total | 19.7 s |
| Workspace used | 340 MiB |

The workload verified 3,000,000 filtered rows and the summary independently on
the client.

## Baseline comparison

The older `file.put`/`file.get` path is limited to 8 MiB and uses a whole-file
buffer. It remains for small files. Streaming adds a round trip per 512 KiB
chunk; for a 1 KiB file this is visible overhead, while for 100 MiB the
round-trip cost is amortized and throughput is limited by the relay/controller
path.

## Reproduction

```bash
make demo-large-file
make benchmark-transfers
make benchmark-transfer-stress   # 256 MiB, explicitly opt-in
```
