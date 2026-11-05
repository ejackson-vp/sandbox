# x402 Confidential Sandbox

Pay-per-execution sandbox service: **one x402 micropayment buys one 60-second
isolated code execution, with no account**. Customer code is encrypted to a key
held by the sandbox guest; the provider's API, controller, relay, database and
logs only ever see ciphertext.

> **Honesty first.** The local demo runs ordinary Kubernetes pods. It is **not**
> confidential computing. Attestation is simulated and labelled
> `INSECURE_DEV_ONLY`; the CLI refuses it unless you pass
> `--allow-insecure-dev`. See [docs/security-guarantees.md](docs/security-guarantees.md)
> for the exact list of what is enforced, simulated and unimplemented.

## Quick start (macOS or Linux, Docker + kind)

Prerequisites: Docker, `kind`, `kubectl`, `cilium` CLI, Node ≥ 24, Go ≥ 1.24.

```bash
make up        # kind cluster + Cilium + images + deploy (~3 min)
make demo      # buy one execution, run examples/hello.py, decrypt the result
make down
```

`make demo` prints:

```
Price: $0.01 (mock payment)
Payment: accepted
Sandbox: provisioning
Attestation: INSECURE_DEV_ONLY (dev-simulated)
  ! SIMULATED ATTESTATION: no hardware root of trust; confidentiality is not enforced.
Sandbox: ready
Uploading encrypted payload...
Executing...

Hello from the sandbox!
user=65532 cwd=/run/x402
hostname=sbx-2f0c...
dns: blocked (gaierror)
cluster api: blocked (timeout)

Exit code: 0
Execution: 1.2s
Sandbox: destroyed
```

Other targets:

```bash
make demo-agent     # same purchase driven by @x402/fetch (agent path)
make demo-timeout   # 3-second budget, encrypted timeout result
make test           # 46 unit + 14 integration tests (no cluster needed)
make security-test  # 12 cluster-backed isolation/lifecycle tests
make logs           # controller logs
```

## The workflow

```bash
node cli/dist/index.js run hello.py \
  --duration 60 \
  --allow-insecure-dev \
  --payment-mode mock \
  --api-url http://localhost:8080
```

1. `POST /v1/sandboxes` → `402` with x402 v2 `PAYMENT-REQUIRED`.
2. The CLI signs an EIP-712 payment authorization and retries.
3. The API verifies + settles through the facilitator, creates **one**
   entitlement and returns a short-lived capability (only its hash is stored).
4. The controller provisions a pod on the tainted sandbox node.
5. The guest connects out to the relay, generates an X25519 keypair and returns
   signed attestation evidence bound to the session, the client nonce and the
   client public key.
6. The CLI verifies the evidence independently, encrypts the Python source to the
   guest key (libsodium sealed box) and uploads ciphertext.
7. The guest decrypts inside the sandbox, executes with a 60-second watchdog,
   encrypts stdout/stderr/exit status to the client key and exits.
8. The CLI decrypts locally and destroys the sandbox; the pod is deleted.

## Repository layout

```
api/                  x402 API server + mock facilitator
controller/           reconciler, SQLite store, session relay, egress proxy
guest/                Go guest runtime + network probe
cli/                  customer CLI and agent demo
shared/               protocol types, sealed-box crypto, attestation verifier
deploy/kind/          kind cluster + Cilium setup
deploy/kubernetes/    manifests (base, dev mode)
deploy/kata/          Mode B overlay (Kata VM, verified runtime classes)
deploy/confidential/  Mode C overlay (SEV-SNP/TDX + Trustee + agent policy)
tests/unit/           46 fast tests
tests/integration/    real guest process + full control plane
tests/security/       real cluster network/lifecycle attacks
docs/                 architecture, threat model, guarantees, readiness
```

## Modes

| Mode | What runs | Confidential? |
| --- | --- | --- |
| **A. Local dev** (default) | kind + Docker + Kubernetes, `runc`, Cilium NetworkPolicy, simulated attestation | **No.** Encrypted transport + control-plane opacity only |
| **B. Kata** | `kata-qemu-coco-dev` (bare metal) or `kata-clh` (kind/minikube), real guest kernel | **No hardware attestation.** VM isolation only |
| **C. Confidential** | `kata-qemu-snp` / `kata-qemu-tdx` + Trustee | Designed; requires TEE hardware to demonstrate |

Mode B: `helm install coco oci://ghcr.io/confidential-containers/charts/confidential-containers --version 0.18.0 -n coco-system --create-namespace`, then `kubectl apply -k deploy/kata`. See [deploy/kata/README.md](deploy/kata/README.md).

Mode C: see [deploy/confidential/README.md](deploy/confidential/README.md) for
the hardware test plan, the Trustee policy, and the exact unimplemented pieces.

## API

```http
POST   /v1/sandboxes                  # x402-protected; body has no code
GET    /v1/sandboxes/{id}             # state + attestation evidence
POST   /v1/sandboxes/{id}/execute     # { "envelope": "<base64 sealed box>" }
GET    /v1/sandboxes/{id}/result      # encrypted result (long-poll)
DELETE /v1/sandboxes/{id}             # destroy now
GET    /v1/pricing                    # public price/network info
```

All session endpoints require `X-Sandbox-Capability: <capability>`. There are no
accounts, cookies or long-lived API keys.

## Design highlights

- **No plaintext in the control plane.** The only execution field is an opaque
  sealed-box envelope. Bodies containing `code`, `source`, `stdout`, `stderr`
  are rejected with `400 plaintext_not_accepted`.
- **One payment, one execution.** Facilitator nonce uniqueness + UNIQUE payment
  key + conditional state transitions; verified under 6-way concurrency.
- **Guest-initiated relay.** Sandbox pods have *no* ingress rules at all; the
  guest dials out over WebSocket. The relay cannot decrypt.
- **Proxy-only egress, no DNS.** NetworkPolicy allows exactly two destinations;
  the proxy resolves names itself, validates every resolved IP and connects to
  the validated IP literal, defeating rebinding.
- **Secrets out of the environment.** An init container writes the relay/proxy
  credentials to a `0400` file; the guest reads and deletes it before any
  customer payload arrives.
- **Three independent timers.** Guest watchdog, controller deadline, and
  Kubernetes `activeDeadlineSeconds`.

## Tests

```
tests/unit          46 passing   crypto interop vectors, attestation fail-closed,
                                 payment replay, IP classification, store invariants
tests/integration   14 passing   real guest process, full x402 flow, replay,
                                 concurrency, capability scoping, deadline, tamper
tests/security      12 passing   packet-level network isolation on Cilium,
                                 pod hardening, log hygiene, controller crash
                                 recovery, PSS enforcement, cluster replay
```

Run: `make test` and `make security-test` (after `make up`).

## Documentation

- [docs/architecture.md](docs/architecture.md) — components, protocol, state machine
- [docs/threat-model.md](docs/threat-model.md) — adversaries and per-mode mitigations
- [docs/security-guarantees.md](docs/security-guarantees.md) — enforced vs simulated
- [docs/production-readiness.md](docs/production-readiness.md) — gaps and next steps

## Licence

Prototype code written for evaluation. No warranty.
