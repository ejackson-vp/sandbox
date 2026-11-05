# Production readiness

This is a working local proof of concept. This document lists every gap between
it and a production service, ordered by risk, with the concrete next step.

## 1. Blocking gaps

| # | Gap | Why it matters | Next step |
| --- | --- | --- | --- |
| 1 | **No hardware attestation** | Mode A/B evidence is signed by a published dev key; nothing is hardware-rooted | Implement `verifyHardwareEvidence` + guest AA integration (Mode C) and run on SNP/TDX hardware |
| 2 | **Shared host kernel in Mode A** | Container escapes are possible for hostile code | Run Mode B (Kata) minimum, Mode C for confidentiality |
| 3 | **SQLite single-writer** | No HA: one controller, one node's PVC | Postgres/DynamoDB with conditional writes; keep the same UNIQUE payment key invariant |
| 4 | **Relay is a single pod with in-memory state** | Relay restart loses pending ciphertext; no HA | Redis/NATS with per-session queues; still ciphertext-only |
| 5 | **Mock payments only in the demo** | No economic security locally | Testnet path exists; add reconciliation + on-chain receipt verification before mainnet |
| 6 | **No image admission control** | A compromised controller could run an arbitrary image | Pin `GUEST_IMAGE` by digest + Kyverno/sigstore policy + CoCo encrypted images |
| 7 | **Secrets in the repo (dev)** | Dev attestation key, admin tokens, proxy secret | External secret manager; remove the dev key entirely in Mode C |

## 2. Security hardening backlog

- **Guest policy in Mode C** (`deploy/confidential/agent-policy.rego`) is written
  but not wired into pod creation. Add `io.katacontainers.config.agent.policy`
  / initdata injection in `controller/src/k8s.ts` and verify the policy hash.
- **Per-session mTLS** between API and controller instead of a shared bearer
  token (NetworkPolicy is the only other control).
- **Relay authentication**: the guest token is a bearer capability; bind it to
  the pod identity as well (e.g. a projected token with a short TTL).
- **Rate limiting** is in-memory per API replica. Move to a shared limiter.
- **Audit log** of payment → session → outcome, with a hash chain.
- **Seccomp profile**: `RuntimeDefault` only. Ship a custom profile for python3.
- **Read-only `/proc`**: consider masking `/proc/kcore`, `/proc/keys`.
- **Drop the client's IP** from logs entirely (currently retained in the default
  HTTP access log for rate limiting; document retention).
- **Resource quotas** per namespace and a hard cap on concurrent sandboxes.
- **Egress allowlist by hostname** is available (`EGRESS_ALLOWED_HOST_SUFFIXES`)
  but disabled; production should enable it to reduce abuse.

## 3. Reliability / operations

- Controller HA with leader election (or a single-writer queue) — the current
  design is deliberately single-writer.
- Persist relay sessions so a relay restart does not fail paid sessions (or
  refund/fail them cleanly).
- Add a settlement outbox: today a crash between `settle` and entitlement insert
  can charge without an entitlement. Mitigation: idempotent settle keyed by the
  payment key + reconciliation against the facilitator's settlement records.
- Metrics: payment outcomes, provisioning latency, execution duration, timeouts,
  reaper actions, proxy denials (by reason), relay capacity.
- Alerts: controller down, relay down, provisioning timeout rate, proxy deny
  spike, PVC full, orphan pods present.
- Load test: 100 concurrent sandboxes, measure provisioning p95 and relay
  fan-out.

## 4. Payments

- Testnet mode uses `https://x402.org/facilitator` and Base Sepolia
  (`eip155:84532`). Verify with a funded wallet:
  ```bash
  EVM_PRIVATE_KEY=0x... ./cli/dist/index.js run examples/hello.py \
    --payment-mode testnet --allow-insecure-dev --api-url https://api.example
  ```
- Before mainnet: use a production facilitator (e.g. CDP), pin the network id,
  add settlement reconciliation, refunds for failed provisioning, and a spend
  cap per payer address.
- Mainnet is intentionally rejected at startup (`api/src/config.ts`).

## 5. Compliance / abuse

- Content policy enforcement for arbitrary code execution.
- Per-payer and per-IP abuse controls (the capability model is anonymous by
  design; payment is the only identity).
- Data retention: session metadata is kept 24 h; ciphertext is dropped after the
  result TTL. Confirm against local law (this is a data-processing service).
- Terms of service, export controls, and a takedown process.

## 6. Definition of "production confidential"

You may claim hardware-backed confidentiality only when all of the following are
true and evidenced:

1. Sandboxes run under `kata-qemu-snp` or `kata-qemu-tdx` on real TEE hardware.
2. The guest obtains evidence from the TEE (not a key it holds).
3. The customer verifies that evidence through an independent verifier
   (Trustee AS or `snpguest`/`tdx-quote-check`) **and** checks the measurement
   allowlist.
4. The verifier rejects simulated evidence, stale evidence, wrong `report_data`,
   and TCB levels below policy.
5. KBS releases any image/secret key only to an attested guest with the expected
   measurement.
6. A negative test demonstrates that a modified image fails attestation.

Until then, the honest description is: *"encrypted in transit and opaque to the
provider's control plane; execution is not hardware-confidential."*
