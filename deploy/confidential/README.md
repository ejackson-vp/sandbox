# Mode C — hardware confidential computing (SEV-SNP / TDX)

Status: **designed and wired to fail closed; not implemented in this
environment.** No TEE hardware was available, so no hardware attestation was
produced or verified. Do not describe Mode C as demonstrated.

## 1. Target architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│ k8s node with AMD SEV-SNP (EPYC 7003+/9004) or Intel TDX (4th/5th gen)   │
│                                                                          │
│  ┌───────────────────────── CoCo pod ──────────────────────────────────┐ │
│  │ RuntimeClass kata-qemu-snp | kata-qemu-tdx                          │ │
│  │  ┌────────────────────── confidential VM ────────────────────────┐  │ │
│  │  │ guest kernel (separate, measured)                            │  │ │
│  │  │  kata-agent  ── guest policy (OPA) rejects host-originated    │  │ │
│  │  │                 exec/file operations not in the allowlist    │  │ │
│  │  │  attestation-agent (AA) ── /aa/attest → SNP report/TDX quote  │  │ │
│  │  │  x402-guest (our runtime) ── keypair, seal/open, execute      │  │ │
│  │  └──────────────────────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│            │ evidence (report_data = H(binding))                        │
│            ▼                                                             │
│  Trustee (KBS + Attestation Service) ── policy ── releases image key /    │
│  per-session secret only to an attested guest                           │
└──────────────────────────────────────────────────────────────────────────┘
```

## 2. Prerequisites (verified upstream references)

- AMD SEV-SNP: BIOS `SMEE`/`SNP` enabled, kernel ≥ 6.5 with
  `CONFIG_KVM_AMD_SEV=y`, `kvm_amd.sev=1`, `kvm_amd.sev_snp=1`; check
  `/sys/module/kvm_amd/parameters/sev_snp` → `Y`.
- Intel TDX: TDX-enabled BIOS, TDX host kernel (Ubuntu 24.04+ / CentOS Stream 9),
  `kvm_intel.tdx=1`; check `/sys/module/kvm_intel/parameters/tdx` → `Y`.
- containerd (CoCo does not support CRI-O in the current release), k8s ≥ 1.24,
  a node labelled `node-role.kubernetes.io/worker=`, SELinux disabled/permissive.
- ≥ 8 GB RAM / 4 vCPU for the CoCo system pods.

## 3. Install

```bash
# Confidential Containers runtime classes (verified chart + runtime class names)
helm install coco oci://ghcr.io/confidential-containers/charts/confidential-containers \
  --version 0.18.0 --namespace coco-system --create-namespace
kubectl get runtimeclass
# kata-qemu-snp  /  kata-qemu-tdx  must be present

# Trustee (Key Broker Service + Attestation Service)
kubectl apply -k github.com/confidential-containers/trustee/deployment?ref=main
```

Then switch this project to Mode C:

```bash
kubectl apply -f deploy/confidential/runtimeclass-sev-snp.yaml   # or -tdx.yaml
kubectl apply -k deploy/confidential                              # sets EXECUTION_MODE=confidential
```

`EXECUTION_MODE=confidential` makes the controller:

- require `ALLOW_INSECURE_DEV=false`,
- require a confidential runtime class (validated at startup: it refuses to
  start with `runc`),
- make the guest refuse to fabricate evidence
  (`guest/internal/attest/attest.go` returns
  `confidential evidence requires a real SEV-SNP/TDX guest agent`),
- make the CLI require hardware evidence when `--require-hardware` is set.

This is the "never silently downgrade" property: selecting Mode C while the
attestation stack is missing produces a hard failure, not a normal pod.

## 4. Remaining implementation work (precise)

### 4.1 Guest evidence (Go)

File: `guest/internal/attest/attest.go`, function `BuildEvidence`.

Replace the `confidential` early-return with:

1. Compute `runtime_data = SHA-256(canonical({sessionId, guestPublicKey,
   clientPublicKey, clientNonce}))` (32 bytes).
2. Call the CoCo attestation-agent over the confidential data hub:
   `POST http://127.0.0.1:8006/aa/attest` with
   `{"tee":"snp","runtime_data":base64(runtime_data)}` (or `"tdx"`).
3. Put the returned evidence in `report`, set `hardwareBacked:true`,
   `insecureDevOnly:false`, `evidenceType:"sev-snp"|"tdx"`.
4. Sign the envelope with the guest key as today (binding the guest key to the
   evidence), and include `claims.guestMeasurement` from
   `/sys/kernel/security/...`/`/proc/cmdline` launch measurement or the AA's
   `initdata`/measurement output.

### 4.2 Client verification (TypeScript)

File: `shared/src/attestation.ts`, function `verifyHardwareEvidence`.

Implement a `HardwareVerifier` interface with two backends:

- `trustee`: POST the evidence to the Attestation Service
  (`/attestation/verify`) with the expected `runtime_data` and a policy id; the
  AS validates the report signature chain, the TCB level, and the policy.
- `local-snp` / `local-tdx`: invoke `snpguest verify attestation` /
  `tdx-quote-check` plus `snpguest fetch ca` and compare `report_data` with
  `runtime_data`.

Acceptance MUST require: valid hardware signature chain, `report_data` equals
`SHA-256(binding)`, TCB not vulnerable per policy, and `hardwareBacked === true`.
Any failure returns `ok:false` (already the default).

Also enforce a **measurement allowlist** (`--expected-measurement`), which is
mandatory in production.

### 4.3 Encrypted workload delivery

Two supported patterns; pick one:

1. **CoCo encrypted image** (ocicrypt): encrypt the guest image key with KBS,
   annotate the pod `io.containerd.cri.runtime-handler: kata-qemu-snp` plus the
   `unencrypted-image`/`encrypted-image` annotations, and set the KBS resource
   path in the pod annotation. The image key is released only after attestation.
2. **Sealed per-session secret**: store the guest image in a normal registry but
   seal the *session bootstrap secret* (already a 0400 file) with the KBS,
   bound to the expected measurement. This is the smaller change.

Either way, the KBS resource policy must be:

```rego
package policy
default allow = false
allow {
  input.submods.container.image_digest == "sha256:<pinned-guest-image>"
  input.submods.snp.earned_boot_claims.snp.measurement == "<expected measurement>"
  input.submods.snp.earned_boot_claims.snp.policy_debug_allowed == false
}
```

### 4.4 Agent (guest) policy — rejecting host-originated operations

CoCo supports an OPA policy enforced by `kata-agent`. Ship
`deploy/confidential/agent-policy.rego` (in this directory) which:

- allows `ExecProcessRequest` only for `/usr/local/bin/x402-guest` and
  `/usr/bin/python3` with fixed argv prefixes,
- denies `CopyFileRequest`, `ReadStreamRequest`, `WriteStreamRequest` whose path
  is outside `/run/x402` and `/tmp`,
- denies every request whose `storage_source` is the host (i.e. host-originated
  exec/file access),
- pins the container image and command.

Install it by adding the policy as a CoCo `initdata`/`policy` annotation on the
pod template (the controller must be extended to inject it) and verify with
`kubectl logs -n coco-system <agent>` that the policy hash matches.

## 5. Hardware test plan (exact steps)

1. Provision a node with SNP (e.g. Azure `DCasv5`, Hetzner `CCX33`/AX102, OVH
   Advance) or TDX (GCP `c3-standard-*`, Azure `DCesv5`).
2. Verify host capability:
   ```bash
   dmesg | grep -i -E 'sev|snp|tdx'
   cat /sys/module/kvm_amd/parameters/sev_snp     # Y
   cat /sys/module/kvm_intel/parameters/tdx       # Y
   ```
3. Install CoCo (`kata-qemu-snp` / `kata-qemu-tdx` present).
4. Deploy this project with `deploy/confidential/`.
5. Run `make demo`. Expected CLI output:
   ```
   Attestation: HARDWARE-VERIFIED (sev-snp)
   ```
6. Independently verify:
   ```bash
   kubectl exec <sandbox-pod> -- ls -l /dev/sev-guest     # inside the VM
   kubectl logs <sandbox-pod> | grep evidenceType          # sev-snp
   ```
   and check the Attestation Service logs show a successful verification for the
   expected measurement.
7. Negative tests:
   - start a pod with `runtimeClassName: x402-sandbox` but a *modified* image →
     attestation must fail (measurement mismatch),
   - point the CLI at a fake evidence blob → `bad_signature` /
     `hardware_verifier_unavailable`,
   - run with `EXECUTION_MODE=confidential` but `runtimeClass=runc` → controller
     refuses to start,
   - replay evidence from another session → `session_mismatch`.
8. Measure side-channel posture and document residual risk (SEV-SNP: CVE-2024-*,
   TDX: TCB recovery cadence).

## 6. What will still be true after Mode C

- Availability and metadata are still visible to the provider.
- A malicious *customer* can still consume their own sandbox.
- Side channels remain.
- The control plane still never holds plaintext.
