# Resource and cost model

Prices are illustrative; the table is configuration (`SESSION_TIERS`), not
economics.

## Tiers (defaults)

| Tier | Duration | CPU | Memory | Disk (workspace) | Price |
| --- | --- | --- | --- | --- | --- |
| `short` | 60 s | 0.5 vCPU | 512 MiB | 256 MiB | $0.02 |
| `standard` | 300 s | 1 vCPU | 1 GiB | 1 GiB | $0.05 |
| `extended` | 900 s | 2 vCPU | 2 GiB | 2 GiB | $0.10 |
| `long` | 1800 s | 2 vCPU | 4 GiB | 4 GiB | $0.20 |
| `custom` | 1 s – `MAX_LEASE_SECONDS` | ≤ 4 vCPU | ≤ 8 GiB | ≤ 8 GiB | prorated from `standard` |

Hard caps (`MAX_LEASE_SECONDS` default 1800; absolute ceiling 3600) cannot be
raised by a request. `ALLOW_CUSTOM_DURATIONS` exists for development and tests.

## What is enforced where

| Limit | Enforcement |
| --- | --- |
| Lease duration | controller deadline (authoritative), guest watchdog, `activeDeadlineSeconds` |
| CPU / memory | Kubernetes container `resources.limits` (mirrored from the tier) |
| Disk | `emptyDir` `sizeLimit` (tier + 32 MiB) **and** the guest's own quota (`diskMiB`) |
| Output | guest truncates stdout/stderr at `maxOutputBytes` (256 KiB default) |
| File size | guest rejects payloads/archives above `maxFileBytes` (8 MiB default) |
| Processes | pod-level `pod-max-pids` (1024) per sandbox; `maxProcesses` is advisory (a per-UID `RLIMIT_NPROC` would be node-wide because all sandboxes share a UID) |
| Command time | guest watchdog (`min(requested, remaining lease, maxCommandSeconds)`) |
| Concurrency | one active operation per session (controller gate) |

## Cost model (operator view)

A session occupies a dedicated pod for `provisioning + lease + teardown`
(typically `30–60 s + lease + ~2 s`). With the `long` tier that is roughly
0.55 pod-hours of a 2 vCPU / 4 GiB slot for $0.20 — the pricing is a placeholder,
not a margin analysis.

Cost drivers:

- **Idle lease time**: customers pay for the window, not for CPU-seconds. A
  session that runs nothing still costs the operator a pod.
- **Provisioning overhead**: image pull is avoided by preloading the image into
  the node; pod start dominates (~3–10 s in kind).
- **Relay bandwidth**: ciphertext only; uploads/downloads are base64 over the
  WebSocket (≈1.33× the file size).
- **Egress**: proxy-only HTTPS, no per-session infrastructure.

## Capacity notes

- The sandbox node is tainted and dedicated; each session is one pod with hard
  limits, so the node's allocatable capacity is the practical concurrency cap.
- The relay is a single in-memory switch in this prototype: ~2 000 sessions per
  relay instance, 8 pending requests per session, 24 MiB frames.
- The controller reconciles serially; at a few hundred pods the 250 ms tick is
  the dominant cost. Production would shard or use informers.

## Abuse controls

- API rate limits per IP (30 creates/min burst, 600 reads/min).
- One payment = one session; replay returns the same session, never a new pod.
- Expired or destroyed sessions cannot be resurrected.
- Per-session egress proxy credential (HMAC, TTL) and 16 concurrent tunnels.
