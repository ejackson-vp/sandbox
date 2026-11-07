# x402 Sandbox Sessions

**Pay once, get a temporary Linux computer.** An accountless client purchases a
leased sandbox with x402, then runs as many commands as it wants inside the
lease, uploads and downloads files, and destroys it (or lets it expire). No
accounts, no API keys, no plaintext commands on the control plane.

```
Pay → Launch sandbox → Execute repeatedly → Destroy
```

> **Honesty first.** The local demo runs ordinary Kubernetes pods. It is **not**
> confidential computing. Attestation is simulated and labelled
> `INSECURE_DEV_ONLY`; the CLI/SDK refuse it unless you pass
> `--allow-insecure-dev`. See [docs/security-guarantees.md](docs/security-guarantees.md).

## Quick start (Docker + kind)

Prerequisites: Docker, `kind`, `kubectl`, `cilium` CLI, Node ≥ 24, Go ≥ 1.24.

```bash
make up             # kind + Cilium + images + deploy (~2 min)
make up-2w          # two workers for scheduling/portability tests only
make demo-session   # the full 11-step session workflow
make demo-expire    # buy a 5s session, watch it expire and clean up
make demo-lifecycle # checkpoint a session, resume it, verify the workspace
make demo-capacity  # capacity reject, suspend, B takes the node, A resume rejected
make demo-placement # two-worker least-allocated placement (make up-2w)
make benchmark-multinode # two-worker burst (make up-2w; shared Docker VM)
make demo-portability # cordon the checkpoint node; prove resume fails fast
make demo-faults    # delete a suspended PVC; restart the controller mid-suspend
make demo-http      # Node HTTP/SSE/WebSocket workload
make demo-python    # Python pandas data-processing workload
make demo-browser   # Playwright/Chromium compatibility probe
make demo-large-file # 100 MiB streaming round trip
make demo-directory # streamed directory archive round trip
make demo-http-basic # minimal Python HTTP server through the relay
make demo-sse       # stream server-sent events through the relay
make demo-ws        # WebSocket echo through the relay
make test           # unit + local integration tests
make test-workloads # workload fixtures and compatibility probes
make test-transfers  # streaming transfer protocol checks
make benchmark-pipeline-probe # transfer window=1 ceiling + concurrency gate probe
make test-control-faults # controller/API/relay kill + mixed lifecycle restart on kind
make security-test  # packet-level isolation + lifecycle tests on the cluster
make down
```

`make demo-session` prints:

```
== 1/11 creating a paid 5-minute session through the mock x402 facilitator
== 2/11 session id and expiry
session:  sbx_61744770c4f79e88223b9f9d
price:    $0.05 (mock payment)
expires:  2026-11-06T00:33:56.919Z
== 3/11 python3 --version
Python 3.12.16
== 4/11 uploading a Python program
== 5/11 running the uploaded program
Hello from the sandbox!
...
== 10/11 destroying the session
Sandbox: destroyed
== 11/11 verifying Kubernetes resources are gone
no sandbox pods remain
```

HTTP: `make demo-http` runs the Node HTTP/SSE/WebSocket workload;
`make demo-http-basic` is the minimal Python server walkthrough in
[docs/http.md](docs/http.md).

Lifecycle: `make demo-lifecycle` exercises the suspend/resume contract; see
[docs/lifecycle.md](docs/lifecycle.md) for the state machine, security caveats
and the AWS Lambda MicroVMs comparison. `make demo-capacity` demonstrates
admission, suspension and re-admission under a deliberately constrained node;
see [docs/admission-design.md](docs/admission-design.md).

Other targets: `make demo` (create + run a file + destroy), `make demo-agent`
(purchase through `@x402/fetch`), `make demo-timeout` (per-command timeout).

## CLI

```bash
sandbox create --tier standard                 # 5 minutes, 1 vCPU, 1 GiB
sandbox create --duration 15m --cpu 2 --memory 2Gi
sandbox exec <id> -- python3 --version
sandbox exec <id> -- bash -c "echo hello > /workspace/hello.txt"
sandbox exec <id> -- cat /workspace/hello.txt
sandbox upload   <id> ./example.py /workspace/example.py
sandbox download <id> /workspace/out.txt ./out.txt
sandbox upload   <id> ./src /workspace/src        # directory → tar
sandbox download <id> /workspace/src ./src --extract
sandbox ls <id> /workspace --recursive
sandbox stat <id> /workspace/out.txt
sandbox status <id>
sandbox destroy <id>
```

Tiers: `short` (60 s), `standard` (300 s), `extended` (900 s), `long` (1800 s),
plus `--duration`/`--cpu`/`--memory`/`--disk` for custom specs within platform
caps. Details: [docs/cli.md](docs/cli.md).

## SDK

```ts
import { SandboxClient, FileSessionStore } from "@x402s/sdk";

const client = new SandboxClient({ apiUrl, paymentMode: "mock", allowInsecureDev: true, store: new FileSessionStore() });
const session = await client.createSession({ tier: "standard" });
await client.waitForReady(session);                     // verifies attestation
await client.exec(session, { command: ["python3", "--version"] });
await client.putFile(session, { path: "/workspace/app.py", data: Buffer.from("print(1)") });
await client.exec(session, { command: ["python3", "/workspace/app.py"] });
const file = await client.getFile(session, "/workspace/app.py");
await client.destroy(session);
```

Full example: [examples/sdk-session.ts](examples/sdk-session.ts).

## API

```http
POST   /v1/sessions                        # x402-protected; body has no plaintext
GET    /v1/sessions/{id}                   # state, lease, limits, attestation
POST   /v1/sessions/{id}/exec              # { requestId, envelope }
PUT    /v1/sessions/{id}/files             # { requestId, envelope }  (file.put)
GET    /v1/sessions/{id}/files?request=…   # encrypted get/list/stat
GET    /v1/sessions/{id}/requests/{rid}    # reconnect / fetch a result
DELETE /v1/sessions/{id}/requests/{rid}    # cancel a running command
DELETE /v1/sessions/{id}                   # destroy now
GET    /v1/pricing
```

All session endpoints require `X-Sandbox-Capability`. Reference:
[docs/api.md](docs/api.md).

## How it works

1. `POST /v1/sessions` → `402` with the price for the requested tier.
2. The client signs the x402 requirement; the API verifies and settles through
   the facilitator.
3. A durable payment intent plus one transaction creates the session; the
   capability is derived from the payment so retries recover the same session.
4. The controller provisions a pod on the tainted sandbox node; the guest
   connects **out** to the relay and returns signed attestation bound to the
   session, nonce and client key.
5. The client verifies attestation, seals each command/file operation to the
   guest key, and decrypts results locally.
6. The lease starts at READY and is immutable. The guest watchdog, the
   controller deadline and `activeDeadlineSeconds` all enforce it.
7. On destroy/expiry the guest is told to stop, the pod is deleted, relay state
   is purged, and the memory-backed workspace disappears with the pod.

Security controls kept from the previous milestone: payment replay prevention,
atomic entitlement redemption, hashed session capabilities, default-deny
networking, proxy-only egress with private-destination denial, no Kubernetes
credentials in the sandbox, encrypted command/result transport, independent
deadlines, orphan cleanup, and no plaintext in control-plane logs.

## Repository layout

```
api/                  x402 API server + mock facilitator
sdk/                  @x402s/sdk client (payment, attestation, exec, files)
cli/                  thin CLI over the SDK
controller/           reconciler, SQLite store, relay, egress proxy
guest/                Go session supervisor + network probe
shared/               protocol, sealed-box crypto, attestation, tiers
deploy/kind/          kind + Cilium setup
deploy/kubernetes/    base manifests (dev mode)
deploy/kata/          Kata VM overlay (future isolation target)
deploy/confidential/  SEV-SNP/TDX design (out of scope, fails closed)
tests/unit/           pricing, store, payment, crypto, attestation
tests/integration/    real guest supervisor + full API/payment flow
tests/security/       real cluster isolation, lifecycle, log hygiene
docs/                 architecture, API, CLI, sessions, threat model, guarantees
```

## Modes

| Mode | What runs | Confidential? |
| --- | --- | --- |
| **Development** | kind, ordinary pods (`runc`), Cilium NetworkPolicy, simulated attestation | **No.** Encrypted transport + control-plane opacity only; not safe for hostile code |
| **Isolated target** | Kata microVMs (`kata-qemu-coco-dev` / `kata-clh`) on KVM hosts | **No hardware attestation.** VM isolation; validate before launch |
| **Future confidential** | `kata-qemu-snp` / `kata-qemu-tdx` + Trustee | Out of scope; verifier fails closed |

## Tests

```
tests/unit          51   specs/tiers, payment replay, outbox, operation gating, crypto, attestation, IP classification
tests/integration   31   real guest supervisor (multi-command, fs, archives, timeouts, cancel, lease)
                         + full API/x402/outbox flow with the SDK
tests/security      12   packet-level network isolation (Cilium), pod hardening, per-tier limits,
                         log hygiene, controller crash recovery, replay, PSS, capability checks
```

Run: `make test` and `make security-test` (after `make up`).

## Documentation

- [docs/status-2026-11-06.md](docs/status-2026-11-06.md)
- [docs/code-size-audit.md](docs/code-size-audit.md)
- [docs/quickstart.md](docs/quickstart.md)
- [docs/workload-compatibility.md](docs/workload-compatibility.md)
- [docs/developer-experience-review.md](docs/developer-experience-review.md)
- [docs/milestone-5-results.md](docs/milestone-5-results.md)
- [docs/transfer-protocol.md](docs/transfer-protocol.md)
- [docs/transfer-security.md](docs/transfer-security.md)
- [docs/transfer-performance.md](docs/transfer-performance.md)
- [docs/milestone-6-results.md](docs/milestone-6-results.md)
- [docs/transfer-pipelining-probe.md](docs/transfer-pipelining-probe.md)
- [docs/control-plane-faults.md](docs/control-plane-faults.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/api.md](docs/api.md)
- [docs/cli.md](docs/cli.md)
- [docs/sessions.md](docs/sessions.md)
- [docs/resource-model.md](docs/resource-model.md)
- [docs/networking.md](docs/networking.md)
- [docs/threat-model.md](docs/threat-model.md)
- [docs/security-guarantees.md](docs/security-guarantees.md)
- [docs/aws-microvms-comparison.md](docs/aws-microvms-comparison.md)
- [docs/capacity-model.md](docs/capacity-model.md)
- [docs/admission-design.md](docs/admission-design.md)
- [docs/reservation-lifecycle.md](docs/reservation-lifecycle.md)
- [docs/scheduling-tradeoffs.md](docs/scheduling-tradeoffs.md)
- [docs/milestone-4-results.md](docs/milestone-4-results.md)
- [docs/capacity-design-review.md](docs/capacity-design-review.md)
- [docs/production-readiness.md](docs/production-readiness.md)

## Explicit non-goals

No coding agent, no GitHub integration, no persistent dev environments, no
memory snapshots (filesystem checkpoints only), no GPUs, no accounts, no managed
wallets, no mainnet payments, no enterprise features.

## Licence

Prototype code written for evaluation. No warranty.
