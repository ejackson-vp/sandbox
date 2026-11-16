# Running sandboxes in microVMs

Overlay on `deploy/kubernetes` that switches the sandbox RuntimeClass from
`runc` to a Kata VM. Each sandbox gets its own guest kernel, so a container
escape inside the sandbox is a kernel exploit against the guest, not against
the node.

```bash
kubectl apply -k deploy/kata
```

The overlay does not create credentials. Create the `x402-secrets` and
`postgres-credentials` Secrets in `sandbox-system` first — locally with
`scripts/dev-secrets.sh`, otherwise from your secret store.

## Requirements

A node that:

1. exposes `/dev/kvm` and has AMD-V or VT-x enabled in firmware;
2. has a Kata runtime installed and registered with containerd;
3. carries the label `x402.io/sandbox-pool=true`.

On Talos the `kata-containers` system extension satisfies (1) and (2).
See [`../talos/`](../talos/) for the cluster-specific overlay, including node
preparation.

## Handler names

The `handler` must match a RuntimeClass handler that containerd knows about.
This is distribution-specific and is the single most common reason a Kata pod
sits in `ContainerCreating`:

| Distribution | Handlers |
| --- | --- |
| Talos `kata-containers` extension | `kata` (Cloud Hypervisor), `kata-qemu` |
| Confidential Containers Helm chart | `kata`, `kata-clh`, `kata-qemu`, `kata-qemu-coco-dev`, … |
| kata-deploy on a bare host | `kata`, `kata-qemu`, `kata-clh`, `kata-fc` if devmapper is configured |

Check with `kubectl get runtimeclass` and set the handler accordingly. The
overlay defaults to `kata`, which is Cloud Hypervisor on Talos.

## What this does and does not give you

| | |
| --- | --- |
| Separate kernel per sandbox | yes |
| Host cannot read guest memory through procfs | yes |
| Hardware-rooted attestation | **no** |
| Protection against a malicious cluster operator | **no** |

See [docs/security-guarantees.md](../../docs/security-guarantees.md) for the
full matrix, including what is enforced and what is not.

## Cost

Budget `130Mi` memory and `250m` CPU per pod for the VM and shim. The
RuntimeClass manifest does not declare an `overhead` block, so the scheduler
accounts only the pod's own requests and limits; this budget is real memory the
node has to hold but that Kubernetes does not reserve for you. On a 13 GiB node
that is roughly 20 sandboxes at a 512 MiB limit, and only if the pool is spread
across nodes.
