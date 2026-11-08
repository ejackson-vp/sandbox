# sandbox

**Pay once with x402, get a temporary Linux machine.** No account, no API key, no
signup. Create a sandbox, run as many commands as you like inside the lease,
move files in and out, then destroy it or let it expire.

```
Pay -> Launch sandbox -> Execute repeatedly -> Destroy
```

Sandboxes run in microVMs on Kubernetes, reach the outside world only through a
relay and egress proxy, and never receive plaintext commands from the control
plane. There is no hardware root of trust: see [Isolation and trust](#isolation-and-trust)
before running anything you would not hand to a hosting provider.

## How it works

1. `POST /v1/sessions` returns `402` with the price for the requested tier.
2. The client signs the x402 requirement; the API verifies and settles it.
3. A durable payment intent plus one transaction creates the session, and the
   capability is derived from the payment — a retry recovers the same session.
4. The controller provisions a pod pinned to a sandbox node. The guest connects
   **out** to the relay and signs a statement binding its ephemeral key to the
   session, nonce and client key.
5. The client verifies that binding, seals each command and file operation to the
   guest key, and decrypts results locally.
6. The lease starts at `READY` and is immutable. The guest watchdog, the
   controller deadline and `activeDeadlineSeconds` all enforce it independently.
7. On destroy or expiry the guest is stopped, the pod is deleted, relay state is
   purged, and the memory-backed workspace disappears with the pod.

## Quick start (local)

Prerequisites: Docker, `kind`, `kubectl`, Cilium CLI, Node >= 24, Go >= 1.24.

```bash
make up             # kind + Cilium + images + deploy (~2 min)
make demo-session   # create, execute, upload, run, destroy
make down
```

`make help` lists every demo and test target. Useful ones:

| Target | What it shows |
| --- | --- |
| `make demo-session` | full session workflow |
| `make demo-expire` | a 5 s lease expiring and cleaning up |
| `make demo-lifecycle` | checkpoint, resume, verify the workspace |
| `make demo-http` | HTTP/SSE/WebSocket workload through the relay |
| `make security-test` | packet-level isolation tests against a live cluster |

Local runs use ordinary containers (`runc`), not microVMs. Use the Talos overlay
for anything that matters.

## Running on a real cluster

```bash
kubectl apply -k deploy/talos
```

See [deploy/talos/README.md](deploy/talos/README.md). Two steps are easy to miss
and produce pods that never schedule or never start: the node label
`x402.io/sandbox-pool=true`, and a StorageClass named `standard`.

For Kata on other clusters, [`deploy/kata/`](deploy/kata/README.md) is the
overlay without the Talos specifics.

## CLI

```bash
sandbox create --tier standard                 # 5 minutes, 1 vCPU, 1 GiB
sandbox create --duration 15m --cpu 2 --memory 2Gi
sandbox exec <id> -- python3 --version
sandbox exec <id> -- bash -c "echo hello > /workspace/hello.txt"
sandbox upload   <id> ./example.py /workspace/example.py
sandbox download <id> /workspace/out.txt ./out.txt
sandbox upload   <id> ./src /workspace/src        # directory -> tar
sandbox download <id> /workspace/src ./src --extract
sandbox ls <id> /workspace --recursive
sandbox stat <id> /workspace/out.txt
sandbox status <id>
sandbox destroy <id>
```

Tiers: `short` (60 s), `standard` (300 s), `extended` (900 s), `long` (1800 s),
plus `--duration`/`--cpu`/`--memory`/`--disk` within platform caps. Details:
[docs/cli.md](docs/cli.md).

## SDK

```ts
import { SandboxClient, FileSessionStore } from "@x402s/sdk";

const client = new SandboxClient({ apiUrl, paymentMode: "mock", store: new FileSessionStore() });
const session = await client.createSession({ tier: "standard" });
await client.waitForReady(session);
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
GET    /v1/sessions/{id}                   # state, lease, limits
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

## Isolation and trust

| Property | Status |
| --- | --- |
| No accounts, no API keys | enforced |
| One settled payment -> one session; replay rejected | enforced, tested |
| API accepts only ciphertext | enforced, tested |
| Control-plane logs and storage free of plaintext | enforced, tested |
| Per-session key exchange; client verifies the binding | enforced |
| No inbound network path to a sandbox | enforced, packet-tested |
| Egress only through the proxy; private destinations denied | enforced, tested |
| Separate kernel per sandbox | **only with Kata** (`deploy/kata`, `deploy/talos`) |
| Hardware-rooted attestation | **not implemented** |
| Protection from a malicious cluster operator | **no** |

The key-binding signature proves the guest holds the key you are sealing to. It
does not prove which software the guest is running, because nothing here is
measured by hardware. If the operator is your adversary, this design does not
help you — run it somewhere you trust, or wait for a TEE-backed version.
Full matrix: [docs/security-guarantees.md](docs/security-guarantees.md).

## Repository layout

```
api/                  x402 API server + mock facilitator
sdk/                  @x402s/sdk client (payment, key binding, exec, files)
cli/                  thin CLI over the SDK
controller/           reconciler, SQLite store, relay, egress proxy
guest/                Go session supervisor + network probe
shared/               protocol, sealed-box crypto, verification, tiers
deploy/kind/          kind + Cilium setup (local dev)
deploy/kubernetes/    base manifests (runc, dev)
deploy/kata/          microVM overlay (any Kata-enabled cluster)
deploy/talos/         real-cluster overlay (Kata + published images)
tests/                unit, property, integration, security
docs/                 architecture, API, CLI, operations, guarantees
```

## Tests

| Suite | Count | Needs |
| --- | --- | --- |
| `npm run test:unit` | 87 | nothing |
| `npm run test:property` | 23 | nothing |
| `npm run test:integration` | 48 | Go toolchain (real guest, no cluster) |
| `make security-test` | 12 | a live cluster (`make up`) |

## Documentation

- [docs/quickstart.md](docs/quickstart.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/api.md](docs/api.md) · [docs/cli.md](docs/cli.md)
- [docs/sessions.md](docs/sessions.md) · [docs/lifecycle.md](docs/lifecycle.md)
- [docs/security-guarantees.md](docs/security-guarantees.md) · [docs/threat-model.md](docs/threat-model.md)
- [docs/networking.md](docs/networking.md) · [docs/transfer-protocol.md](docs/transfer-protocol.md)
- [docs/payment-ledger.md](docs/payment-ledger.md) · [docs/cost-model.md](docs/cost-model.md)
- [docs/capacity-model.md](docs/capacity-model.md) · [docs/warm-pool.md](docs/warm-pool.md)
- [docs/production-readiness.md](docs/production-readiness.md) · [docs/control-plane-faults.md](docs/control-plane-faults.md)

## Non-goals

No coding agent, no GitHub integration, no persistent dev environments, no memory
snapshots (filesystem checkpoints only), no GPUs, no accounts, no managed
wallets, no mainnet payments, no enterprise features.

## Licence

MIT — see [LICENSE](LICENSE).
