# Milestone 5 results: workload compatibility and developer experience

Status: measured on the local kind rig. All workloads used synthetic data, mock
x402 settlement and the public SDK. No security control was relaxed.

## A. Compatibility matrix

| Workload | Works? | Limitations | Changes needed |
|---|---|---|---|
| Python data processing | **Measured, passes** | 1.5 MiB input; pandas installed at runtime | none for this dataset |
| Node HTTP | **Measured, passes** | npm install; service must be restarted after resume | none |
| SSE | **Measured, passes** | relay window; 3 events in 135–138 ms | none |
| WebSockets | **Measured, passes** | 3 round trips in 41–52 ms | none |
| Playwright / Chromium | **Attempted, blocked** | no Chromium in stock image; Playwright executable missing | dedicated pinned browser image |
| Suspend/resume | **Measured, files only** | processes and sockets are gone; service restart required | restart policy or explicit service API |
| File transfer >8 MiB | **Blocked** | 8 MiB per-upload limit; 9 MiB rejected | chunked/streaming upload |

## B. Developer experience

The public SDK was sufficient to complete Python and Node workloads. The
initial flow required handle management, `waitForReady`, base64 file handling
and `try/finally` cleanup. A `Sandbox` facade now provides:

```ts
const sandbox = await client.create({ durationSeconds: 60, cpuMillis: 1000, memoryMiB: 1024, diskMiB: 512 });
await sandbox.upload("./input.csv", "/workspace/input.csv");
const result = await sandbox.exec({ command: ["python3", "/workspace/process.py"] });
await sandbox.download("/workspace/result.csv", "./result.csv");
await sandbox.destroy();
```

`examples/sdk-quickstart/index.ts` is 32 lines and imports only `@x402s/sdk`.

Friction found and fixed:

- custom resource options now infer `tier: "custom"`;
- oversized uploads now fail as `file_too_large` before encryption;
- a crashed service can be restarted under the same name (dead entry replaced);
- `pip` and `npm` are present in the guest image.

Remaining friction:

- no chunked/streaming uploads over 8 MiB;
- services do not survive suspend/resume;
- no automatic service restart/supervision;
- SSE/WebSocket wrappers are not on `Sandbox` yet;
- no upload/install progress reporting;
- no retry policy for transient relay errors.

## C. Performance

### Python data processing

100k rows, 1.52 MiB CSV, pandas installed into `/workspace/.deps`.

| Stage | Sandbox |
|---|---:|
| Session ready | 1.37–1.54 s |
| Upload | 109–152 ms (~10–14 MiB/s) |
| `pip install pandas` | 5.36–5.67 s |
| Python execution | 0.34 s |
| Download both artifacts | 14–16 ms |
| Total | **7.2–7.7 s** |
| Peak guest memory | 319–333 MB |

Disposable Docker baseline using the same guest image and mounted workspace:
**6–9 s total over three runs**. The Docker baseline used direct host networking;
the sandbox used the authenticated egress proxy. The difference is within the
noise of pip download/install; dependency installation dominates, not
Kubernetes.

### Node HTTP service

| Stage | Sandbox |
|---|---:|
| Session ready | 1.53–1.93 s |
| `npm install` (Express + `ws`) | 2.76–2.78 s |
| Service ready | 120–122 ms |
| HTTP POST `/transform` | 11 ms |
| SSE 3 events | 135–138 ms |
| WebSocket 3 round trips | 41–52 ms |
| Total | **4.7–5.1 s** |

Disposable Docker baseline: **~2 s from container start to `/health` 200**,
including `npm install` (direct host networking). Sandbox provisioning,
encrypted upload and the egress proxy account for most of the difference;
HTTP/SSE/WS application latency itself is small.

### Browser

Not performance-measured. Playwright installed, but the stock image has no
Chromium executable. No browser flags or pod security controls were weakened.

## D. Security

- Cilium default-deny, relay-only ingress, Pod security context and egress proxy
  were unchanged.
- `pip`/`npm` were added to the guest image. They run as the unprivileged guest
  user inside the sandbox; this increases image/tool surface but not the trust
  boundary.
- No privileged containers, no browser sandbox disabling, no host mounts.
- Commands/files/results remain sealed envelopes.
- Capability derivation was reviewed: the capability is HMAC-SHA256 over the
  payment key with a server-only secret. Possession of observable payment data
  alone does not reproduce it. Retries are deterministic, which is required for
  idempotent recovery.
- Service crash/restart does not bypass capability or lease enforcement.
- Known limitation: ordinary kind Pods are not secure isolation for hostile
  customer code.

## E. Economics

Python workload, mock payments only:

| Scenario | Measured |
|---|---:|
| Fresh sandbox per task (3 tasks) | **22.4 s** |
| One leased sandbox, install once, 3 runs | **8.3 s** |
| Suspend after one run, resume and run again | **12.8 s** |
| Install once | 5.45 s |
| Reused exec | 0.29–0.30 s |
| Suspend | 20 ms |
| Resume | 871 ms |
| Second exec after resume | 0.32 s |

Session reuse is clearly valuable for repeated tasks: the second and third
Python runs avoid the 5.4 s install. Suspend is worthwhile for idle gaps, but
the 871 ms resume plus explicit service restart makes it less attractive for
very short gaps. Filesystem checkpoint storage is retained while suspended;
compute is released. Mock prices are not economic costs.

## F. Recommendations

Ranked by customer impact, effort, performance and security:

1. **Chunked/streaming uploads** — removes the 8 MiB wall that blocks real
   datasets and browser screenshots. Medium effort; no relaxation of message
   limits; needs bounded memory and per-session byte caps:
   - customer impact: high,
   - performance: removes full-buffer copies,
   - security: must preserve per-session byte caps and memory bounds.
2. **Service lifecycle/restart policy** — add explicit service restart or a
   supervised restart on crash, and document restart after resume.
   - customer impact: high for HTTP workloads,
   - effort: medium,
   - security: must not bypass capability/lease or leave orphan processes.
3. **Pinned browser-capable guest image** — a separate, reviewed image with
   Chromium and required libraries.
   - customer impact: high for agent/browser use,
   - effort: high,
   - security: browser sandbox flags, /dev/shm, PID limits and image provenance
     need explicit review. Do not add Chromium to the stock image casually.
4. **SDK service/stream helpers** — put `startService`, `openHttpStream` and
   `openWebSocket` on `Sandbox` and add readiness helpers.
   - customer impact: medium,
   - effort: low,
   - security: none.
5. **Progress and cancellation UX** — upload/install progress and clearer
   cancellation semantics.
   - customer impact: medium,
   - effort: medium,
   - security: low.

Do not build an orchestration framework, GitHub integration, coding agent,
GPU support, Firecracker/Kata, HA controller or autoscaling from this evidence.
The meaningful blockers are upload size and browser runtime, not missing
platform abstractions.

## Reproduction

```bash
make up
make demo-python
make demo-http
make demo-browser      # expected to report the missing Chromium runtime
npx tsx examples/node-http-service/faults.ts
npx tsx examples/python-data-processing/reuse.ts
npx tsx examples/sdk-quickstart/index.ts
make test-workloads
```

Existing verification:

- full suite: **156 passed, 3 skipped** after the workload additions;
- build and structural lint: clean;
- benchmark smoke: create 63 ms, ready 1.73 s, first exec 19.6 ms, destroy
  112 ms.
