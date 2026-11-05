# Mode B — Kata Containers (real VM, no hardware attestation)

This mode runs each sandbox inside an actual VM with its own guest kernel. It is
**stronger than Mode A** (a VM boundary instead of a shared host kernel) and
**weaker than Mode C** (no hardware-rooted attestation, so evidence remains
simulated and is still labelled `INSECURE_DEV_ONLY`).

Verified against the upstream Confidential Containers quickstart
(<https://github.com/confidential-containers/confidential-containers/blob/main/quickstart.md>).
The runtime classes installed by the CoCo Helm chart are:

| RuntimeClass | Meaning |
| --- | --- |
| `kata` | convenience alias for the default Kata handler |
| `kata-clh` | Kata + Cloud Hypervisor VM |
| `kata-qemu` | Kata + QEMU VM |
| `kata-qemu-coco-dev` | Kata + QEMU + CoCo building blocks, **no confidential hardware** |
| `kata-qemu-snp` | Kata + QEMU + AMD SEV-SNP |
| `kata-qemu-tdx` | Kata + QEMU + Intel TDX |

## Installation (Linux host with KVM)

```bash
# 1. A containerd-based cluster with at least one worker node labelled
#    node-role.kubernetes.io/worker= (CoCo requirement).
#    On a real host with KVM, do NOT use kind.

# 2. Install the CoCo runtime classes + Trustee-free dev stack
helm install coco oci://ghcr.io/confidential-containers/charts/confidential-containers \
  --version 0.18.0 \
  --namespace coco-system --create-namespace

kubectl -n coco-system get pods --watch     # wait for Running
kubectl get runtimeclass                   # verify the table above
```

## Which runtime class to use

- **Bare-metal / VM host with KVM and nested virt:** `kata-qemu-coco-dev`
  (`deploy/kata/runtimeclass-coco-dev.yaml`).
- **kind or minikube on Linux:** upstream explicitly says QEMU does **not** work
  with kind/minikube and to use `kata-clh` instead
  (`deploy/kata/runtimeclass-kata-clh-kind.yaml`). This still gives a real VM
  with a separate kernel.
- **Hardware TEE:** see `deploy/confidential/`.

## Switch the deployment to Mode B

```bash
# Choose ONE of:
kubectl apply -f deploy/kata/runtimeclass-coco-dev.yaml
# or
kubectl apply -f deploy/kata/runtimeclass-kata-clh-kind.yaml

kubectl -n sandbox-system patch configmap control-config --type merge \
  -p '{"data":{"EXECUTION_MODE":"kata"}}'
kubectl -n sandbox-system rollout restart deploy/controller
```

Or use the overlay: `kubectl apply -k deploy/kata` (edit the overlay comment to
pick the runtime class file you need).

## What is actually enforced

- Each sandbox runs in a VM with a separate guest kernel. The guest reports
  `/proc/sys/kernel/osrelease` inside the attestation claims; compare it with the
  host kernel to demonstrate the separation:

  ```bash
  kubectl get node -o jsonpath='{.items[0].status.nodeInfo.kernelVersion}'
  ./sandbox run examples/hello.py --allow-insecure-dev --payment-mode mock
  # the CLI prints "guest kernel: ..." which differs from the host kernel
  ```

- The pod spec, NetworkPolicy, capability model and encrypted payload path are
  identical to Mode A.

## What is NOT provided

- No hardware attestation: evidence is signed with the dev key and marked
  `insecureDevOnly: true`. The CLI still refuses it without
  `--allow-insecure-dev`.
- No memory encryption, no integrity protection against a privileged host
  administrator (see `docs/threat-model.md`).

## Verifying with the test suite

```bash
make security-test          # same tests, now against Kata VMs
```

The tests assert the pod's `runtimeClassName` and that the guest kernel differs
from the host kernel when `EXECUTION_MODE=kata`.
