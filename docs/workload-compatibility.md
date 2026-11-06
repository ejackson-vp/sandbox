# Workload compatibility

Measured on the local kind rig with the stock guest image, mock x402 payments,
and only synthetic data. The local runtime is an ordinary Pod; this is not a
hostile-code isolation claim.

## Matrix

| Workload | Works? | Limitations | Changes needed |
|---|---|---|---|
| Python data processing | **Yes** | 1.5 MiB upload; pandas installed at runtime into `/workspace/.deps` | none for this dataset |
| Runtime pip install | **Yes** | 3.2–5.5 s; installs into workspace; no cache | none |
| Node HTTP service | **Yes** | npm install into workspace; no supervisor restart on suspend | service must be restarted after resume |
| SSE | **Yes** | 3 events delivered; stream closes normally | none |
| WebSocket | **Yes** | 3 echo round trips; polled relay window | none |
| Playwright / Chromium | **No** | no Chromium binary in stock image; Playwright launch fails | dedicated pinned browser image |
| Suspend/resume | **Yes, files only** | processes/sockets are gone; service must be restarted | explicit service restart support |
| File transfer >8 MiB | **No** | per-upload limit 8 MiB; 9 MiB rejected | chunked/streaming upload |

## Workload A: Python data processing

Fixture: `examples/python-data-processing/`

- 100,000 deterministic rows, **1.52 MiB** CSV.
- pandas installed with
  `python3 -m pip install --target /workspace/.deps pandas`.
- Aggregation, filtering, `result.csv`, `summary.json`.
- Client independently verifies all five category groups and the JSON summary.

Representative run:

| Stage | Time |
|---|---:|
| Session ready | 1.37–1.54 s |
| Upload 1.52 MiB | 109–152 ms (~10–14 MiB/s) |
| `pip install pandas` | 5.36–5.67 s |
| Python execution | 0.34 s |
| Download both artifacts | 14–16 ms |
| Total | **7.2–7.7 s** |
| Peak guest memory | 319–333 MB |
| Workspace used | 187 MiB of 1 GiB |

The CSV fit under the existing 8 MiB file limit. A 9 MiB upload is rejected
client-side with `file_too_large` before encryption/transfer. Streaming or
chunked upload is not implemented.

## Workload B: Node HTTP + SSE + WebSocket

Fixture: `examples/node-http-service/`

- Express, `GET /health`, `POST /transform`, SSE `/events`, WebSocket `/ws`.
- `npm install` into `/workspace/app`; service started with `startService`.

Representative run:

| Stage | Time |
|---|---:|
| Session ready | 1.53–1.93 s |
| `npm install` (Express + ws) | 2.76–2.78 s |
| Service ready | 120–122 ms |
| HTTP POST `/transform` | 11 ms |
| SSE 3 events | 135–138 ms |
| WebSocket 3 round trips | 41–52 ms |
| Total | **4.7–5.1 s** |

Fault probes (`faults.ts`):

- service crash: stopped responding as expected; **restart under the same name
  now works** after the guest fix;
- SSE client disconnect: service survived;
- suspend while service is running: service stopped with the checkpoint;
- resume: files and `node_modules` survive, but the process does not; explicit
  service restart succeeded;
- lease expiry: session reached a terminal state.

## Workload C: Playwright / Chromium

Fixture: `examples/browser-automation/`

Attempted:

1. installed `playwright-core` into `/workspace/browser`;
2. queried `chromium`, `chromium-browser`, `google-chrome` — none present;
3. ran Playwright with the default executable.

Result:

```text
browserType.launch: Executable doesn't exist at
/workspace/.cache/ms-playwright/chromium_headless_shell-.../chrome-headless-shell
```

Root cause: the stock Alpine guest has no Chromium runtime and no browser
dependencies. This is an image/runtime limitation, not an SDK or relay failure.
Installing Chromium at runtime is not possible as the unprivileged sandbox user,
and a browser-capable image needs a deliberate build and security review
(including shared memory, PID limits and browser sandbox flags).

**Not implemented:** a browser image. The stock platform does not claim browser
automation support.

## Failure classification

| Failure | Class | Intentional? | Smallest fix |
|---|---|---|---|
| No pip in image | Missing runtime dependency | No | add `py3-pip` (done) |
| No npm in image | Missing runtime dependency | No | add `npm` (done) |
| 9 MiB upload rejected opaquely | SDK ergonomics / file limit | Limit intentional; error was not | client-side `file_too_large` check (done) |
| Service cannot restart after crash | Lifecycle / guest | No | replace dead registry entry (done) |
| Service lost on resume | Lifecycle limitation | Yes, filesystem checkpoint | explicit restart; document |
| No Chromium | Missing runtime dependency | Yes for stock image | dedicated pinned browser image |
| SSE/WS work only through relay | Networking design | Yes | none |
| pip/npm need HTTPS | Networking restriction | Yes, proxy-only | none; proxy already works |

## Security boundaries

No security control was relaxed:

- Cilium default-deny and relay-only ingress unchanged.
- Pod security context unchanged.
- No privileged containers or `--no-sandbox` browser flags were added.
- Egress still goes through the authenticated HTTPS proxy.
- Package managers run inside the sandbox as the unprivileged guest user.
- Commands, files and results remain sealed envelopes.
- Capacity reservations and session cleanup remain in force.

Adding `pip`/`npm` increases the guest image attack surface and package-install
network use, but does not change the trust boundary: all of it runs inside the
sandbox.
