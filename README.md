<p align="center">
  <img src="docs/assets/logo.svg" width="300" alt="sandbox">
</p>

<p align="center">
  <!-- Quality and security: does it work, and is it checked? -->
  <a href="https://github.com/ejackson-vp/sandbox/actions/workflows/ci.yml"><img src="https://github.com/ejackson-vp/sandbox/actions/workflows/ci.yml/badge.svg?branch=main" alt="ci"></a>
  <a href="https://github.com/ejackson-vp/sandbox/actions/workflows/codeql.yml"><img src="https://github.com/ejackson-vp/sandbox/actions/workflows/codeql.yml/badge.svg?branch=main" alt="codeql"></a>
  <a href="https://github.com/ejackson-vp/sandbox/actions/workflows/docs.yml"><img src="https://github.com/ejackson-vp/sandbox/actions/workflows/docs.yml/badge.svg?branch=main" alt="docs"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/ejackson-vp/sandbox"><img src="https://api.scorecard.dev/projects/github.com/ejackson-vp/sandbox/badge" alt="OpenSSF Scorecard"></a>
  <a href="https://github.com/ejackson-vp/sandbox/actions/workflows/ci.yml"><img src="https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/ejackson-vp/sandbox/badges/coverage.json" alt="coverage"></a>
  <a href="https://github.com/ejackson-vp/sandbox/actions/workflows/release.yml"><img src="https://github.com/ejackson-vp/sandbox/actions/workflows/release.yml/badge.svg" alt="release"></a>
</p>

<p align="center">
  <!-- Release and toolchain -->
  <a href="https://github.com/ejackson-vp/sandbox/releases"><img src="https://img.shields.io/github/v/release/ejackson-vp/sandbox?include_prereleases&label=version" alt="latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT"></a>
  <img src="https://img.shields.io/badge/status-alpha-orange" alt="status: alpha">
  <a href="guest/go.mod"><img src="https://img.shields.io/badge/go-1.26-00ADD8?logo=go&logoColor=white" alt="go 1.26"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D24-5FA04E?logo=nodedotjs&logoColor=white" alt="node >= 24"></a>
</p>

<p align="center">
  <!-- What it is -->
  <img src="https://img.shields.io/badge/runtime-Kata%20microVMs-blue" alt="runtime: Kata microVMs">
  <img src="https://img.shields.io/badge/payments-x402-purple" alt="payments: x402">
  <img src="https://img.shields.io/badge/commands-client--sealed-blue" alt="commands sealed client-side">
  <img src="https://img.shields.io/badge/accounts-none-brightgreen" alt="no accounts">
</p>

**Pay once with x402, get a temporary Linux machine.** No account, no API key, no
signup, and the control plane never sees what you run.

<p align="center">
  <img src="docs/assets/demo.gif" width="900" alt="Terminal recording: pay, create, exec, upload, run, download, destroy">
</p>

Unedited recording of `make demo-session` against a local kind cluster.

| Warm session ready | Exec round trip | Cold start (image cached) | Idle cost per guest |
| :---: | :---: | :---: | :---: |
| **127 ms** p50 | **53 ms** p50 | **2.69 s** p50 | **~182 MiB** |

Kata on two nodes with a 20-guest warm pool, control **0.1.16** (measured
2026-11-09); p50 unless stated. [Method and caveats](docs/performance-cluster.md).

## Why

Agent tool calls are untrusted code, and most sandboxes require an account and
hand the operator your plaintext commands. This does the opposite: the payment
is the identity, and commands and files are sealed client-side to the guest, so
the API, controller and relay only route ciphertext.

Good fits: agent tool execution, CI and build isolation, code-runner backends,
one-off data jobs that should not touch your laptop.

## How it works

1. **Pay.** `POST /v1/sessions` answers `402` with a price. A signed payment is
   the entitlement, so there is no account to create.
2. **Provision.** The controller runs one Kata microVM per session, from the
   warm pool or cold.
3. **Run.** Commands and files are sealed to the guest's ephemeral key. The API,
   controller and relay move opaque frames and cannot read them.
4. **Destroy.** The lease ends, the pod is deleted, and the memory-backed
   workspace disappears with it.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant A as API
    participant K as Controller / relay
    participant G as Guest microVM

    C->>A: POST /v1/sessions
    A-->>C: 402 + price
    C->>A: signed payment
    A->>K: entitlement
    K->>G: provision pod, start guest
    G->>K: outbound WebSocket + key binding
    K-->>C: key binding, relayed
    C->>A: sealed command
    A->>K: opaque envelope
    K->>G: opaque frame
    G-->>C: sealed result, relayed
```

The lease starts at `READY` and is immutable: the guest watchdog, the controller
deadline and `activeDeadlineSeconds` enforce it independently.

More: [architecture](docs/architecture.md) · [sessions](docs/sessions.md) ·
[warm pool](docs/warm-pool.md).

## What holds, and what does not

| Claim | How it is enforced |
| --- | --- |
| The lease ends on time | Guest watchdog, controller deadline and `activeDeadlineSeconds`, independently |
| Commands and files stay private | Sealed client-side to the guest; the API, controller and relay only route ciphertext |
| Nothing can dial in | The guest dials out to the relay; egress only through an allowlisting proxy on 443 |
| Isolation is a VM, not a container | One Kata microVM per session, on tainted, default-deny nodes |

What this is not: no hardware attestation, no mainnet payments, no accounts. The
[threat model](docs/threat-model.md) spells out what that costs, and
[production readiness](docs/production-readiness.md) lists the gap to a hosted
service.

## Try it

Prerequisites: Docker, `kind`, `kubectl`, Cilium CLI, Node >= 24, Go >= 1.26.

```bash
make up             # kind + Cilium + images + deploy (~2 min)
make demo-session   # pay, create, exec, upload, run, download, destroy
make down
```

Local clusters use `runc`, not microVMs. The demo exercises the same API, relay
and guest as a real deployment.

Without a cluster, most of the system is testable in under a minute:

```bash
npm ci
make verify          # typecheck, structure lint, unit + property tests
make test            # adds integration tests against the real guest binary
```

`make security-test` runs the packet-level isolation suite against a live
cluster. `make guest && npm run test:coverage` prints the TypeScript coverage
behind the README badge.

## Interfaces

```bash
sandbox run -- python3 --version               # one-shot: create, run, destroy
sandbox create --tier standard                 # 5 minutes, 1 vCPU, 1 GiB
sandbox exec <id> -- python3 --version
sandbox run --file data.csv=data.csv --return out.csv -- python3 analyze.py
sandbox upload <id> ./src /workspace/src       # directory -> tar
sandbox download <id> /workspace/out.txt ./out.txt
sandbox destroy <id>
```

Tiers: `short` (60 s), `standard` (300 s), `extended` (900 s), `long` (1800 s),
plus `--duration`, `--cpu`, `--memory`, `--disk` within platform caps.

```ts
import { SandboxClient, FileSessionStore } from "@x402s/sdk";

const client = new SandboxClient({ apiUrl, paymentMode: "mock", store: new FileSessionStore() });
const session = await client.createSession({ tier: "standard" });
await client.waitForReady(session);
const result = await client.exec(session, { command: ["python3", "--version"] });
await client.destroy(session);

// One-shot: fresh session, upload, exec, collect, destroy (files are
// workspace-relative). Only the "base" runtime is available today.
const run = await client.run({
  command: ["bash", "-c", "python3 main.py > out.txt"],
  files: { "main.py": "print('hello')" },
  returnFiles: ["out.txt"],
});
console.log(run.exitCode, run.stdout, run.files["out.txt"]);
```

`@x402s/sdk` builds from source (`npm ci && npm run build`), not npm.

<details>
<summary>HTTP API</summary>

```http
POST   /v1/sessions                            # x402-protected; body has no plaintext
POST   /v1/sessions/{id}/operations            # { requestId, envelope }; op is inside
GET    /v1/sessions/{id}/operations?request=…  # encrypted get/list/stat
DELETE /v1/sessions/{id}                       # destroy now
```

All session endpoints require `X-Sandbox-Capability`. Reference:
[docs/api.md](docs/api.md) · [docs/cli.md](docs/cli.md).

</details>

## Performance

| Metric | n | p50 | p95 |
| --- | ---: | ---: | ---: |
| Warm server ready (pool = 20) | 50 | **127 ms** | 286 ms |
| Warm client ready | 50 | **395 ms** | 708 ms |
| Existing-session exec | 50 | **53 ms** | 108 ms |
| Cold server ready (image cached) | 10 | 2.69 s | 3.33 s |

0.1.16 caches the x402 challenge for repeat creates and removes a redundant
capacity round trip; warm client ready fell from 665 ms to 395 ms (p50, steady
client with the challenge cached) and the server side from 179 ms to 127 ms.

These numbers were taken on **0.1.16**. On 0.1.22 the same 50-sample harness
measured 292-354 ms server and 548-595 ms client across two runs, so treat this
table as the baseline, not a current promise.
[Issue #116](https://github.com/ejackson-vp/sandbox/issues/116) tracks the
regression.

60 concurrent held sessions and 25/25 burst creates completed with zero failures;
the bottleneck is the create queue at ~1.3/s, not VM boot. Sources:
[cluster numbers](docs/performance-cluster.md) ·
[engineering notes](docs/engineering-notes.md) ·
[harness](https://github.com/ejackson-vp/sandbox-bench).

## Lab notebook

Three things the benchmarks changed my mind about:

- **The VM was never the bottleneck.** 127 ms server-side against 395 ms
  client-side, so ~268 ms is paid create and polling. That gap is the product
  target. [Read more](docs/engineering-notes.md#the-create-path-is-the-product-not-the-vm-boot)
- **Bursts queue, they do not thrash.** 25 simultaneous creates finished 25/25
  in 19 s, which is exactly the ~1.3 creates/s the queue allows. Latency grows
  predictably and nothing fails.
  [Read more](docs/engineering-notes.md#burst-traffic-queues-it-does-not-thrash)
- **A warm pool costs memory, not time.** ~182 MiB per idle guest, about 3.6 GiB
  for a pool of 20 across two nodes, which is why pool size is a knob.
  [Read more](docs/engineering-notes.md#held-sessions-are-admission-bound-not-memory-bound)

## Documentation

- **New here:** [quickstart](docs/quickstart.md) · [architecture](docs/architecture.md)
- **Security reviewer:** [guarantees](docs/security-guarantees.md) · [threat model](docs/threat-model.md) · [networking](docs/networking.md)
- **Operator:** [Talos deploy](deploy/talos/README.md) · [capacity model](docs/capacity-model.md) · [production readiness](docs/production-readiness.md)
- **Contributor:** [ADRs](docs/adr/) · [CONTRIBUTING.md](CONTRIBUTING.md)

Full index: [docs/README.md](docs/README.md).

## Status

**Alpha.** A reference deployment, not a hosted service: payments are mock or
testnet, and there is no hardware attestation. What is missing, in order:
[docs/production-readiness.md](docs/production-readiness.md). What comes next:
[ROADMAP.md](ROADMAP.md).

Current limitations: no memory snapshots (filesystem checkpoints only), no GPUs,
no arbitrary OCI images, mock or testnet payments only, and checkpoints are
plaintext on disk (see
[docs/adr/0007](docs/adr/0007-checkpoint-at-rest-plaintext.md)).

Non-goals: a hosted commercial service, accounts, managed wallets, mainnet
payments, hardware-attestation claims, feature parity with general-purpose
sandbox platforms, and application-specific integrations. It does not ship a
coding agent; callers may run one. Prepared runtimes and stateful sessions are
in scope; a full IDE or dev-platform is not.
