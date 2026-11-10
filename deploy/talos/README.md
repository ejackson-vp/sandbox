# Deploying to a real cluster (Talos)

In the homelab this path is **reconciled by Flux** from `ejackson-vp/homelab`
(`apps/sandbox/release.yaml`); nothing here is applied by hand. Standalone, or to
preview exactly what Flux will apply:

```bash
kubectl kustomize deploy/talos   # render only
kubectl apply -k deploy/talos    # only if you are not running Flux
```

This overlay does **not** create the `x402-secrets` Secret: the base ships no
credentials. Create it in `sandbox-system` before applying — locally with
`scripts/dev-secrets.sh`, on a real deployment from your secret store. The
homelab applies it from the private repository (SOPS-encrypted).

This is the overlay used for a two-node Talos cluster with the
`kata-containers` system extension. It extends `deploy/kata`, so sandboxes run
in microVMs, but every step below is required for them to actually schedule and
run.

## 1. Node preparation

Sandbox pods are pinned to nodes labelled `x402.io/sandbox-pool=true` and they
tolerate `x402.io/sandbox:NoSchedule`. On kind this label comes from the
kubeadm config; on any other cluster you have to set it.

```bash
kubectl label node <sandbox-node> x402.io/sandbox-pool=true
```

Only label nodes you are willing to run hostile code on. Do **not** label the
node running etcd unless it is genuinely disposable — a runaway sandbox there
takes the control plane with it. On Talos this belongs in the machine config so
it survives a reinstall (`KubeNodeConfig.labels`), not in an imperative
`kubectl label`.

Verify the runtime is actually available before deploying, or pods will sit in
`ContainerCreating` forever:

```bash
kubectl get runtimeclass x402-sandbox -o jsonpath='{.handler}{"\n"}'   # expect: kata
talosctl -n <sandbox-node> ls /dev/kvm                                 # expect: kvm
```

## 2. Storage

Checkpointed (suspendable) sessions need a StorageClass named `standard`:

```bash
kubectl get storageclass standard
```

Anything that can provision a `ReadWriteOnce` volume works —
`local-path-provisioner` is enough for a single node. Without it, sessions can
be created and executed but `suspend`/`resume` fails.

On this cluster `standard` is `local-path-provisioner`, so a suspended session's
workspace is a directory on the node and is **not encrypted**. `local-path` has
no encryption parameter, there is no CSI driver to configure, and no key exists
in the guest or the controller once the pod is gone: the node and storage
administrators can read the files. Do not describe a checkpoint as encrypted on
this deployment. An encrypted CSI StorageClass, on a cloud that provides one,
reduces exposure to a detached disk; it does not remove the node admin and the
controller cannot verify it. See
[ADR 0007](../../docs/adr/0007-checkpoint-at-rest-plaintext.md) and
[lifecycle.md](../../docs/lifecycle.md#checkpoint-at-rest-expiry-and-backup).

## 3. Images

`release.yml` publishes two images on a `v*` tag:

| Image | Contents |
| --- | --- |
| `ghcr.io/ejackson-vp/sandbox-control` | api, controller, relay, egress proxy, facilitator |
| `ghcr.io/ejackson-vp/sandbox-guest` | the sandbox runtime that runs inside the microVM |

Bump `newTag` in `kustomization.yaml` and `GUEST_IMAGE` together — they are the
same release.

`GUEST_IMAGE_DIGEST` is set from the release output and the controller refuses
to start with the dev placeholder when `KUBERNETES_ENABLED=true` (the cluster
default), even while `ALLOW_INSECURE_DEV=true`. The placeholder is only valid
for the local process provisioner (`KUBERNETES_ENABLED=false`), which does not
put an image reference in a pod spec. Keeping the digest pinned here is what
stops a moved tag from changing what runs inside the VM.

## 4. Public URL

`PUBLIC_BASE_URL` defaults to a placeholder. Set it to the address clients use
to reach the API. With the Tailscale operator this is the MagicDNS name of the
API's `Ingress`, e.g. `https://sandbox.<tailnet>.ts.net`.

## 5. Monitoring

The metrics stack is deliberately a separate overlay:
[`../monitoring`](../monitoring/README.md) installs VictoriaMetrics
single-node, Grafana and vmalert into the `monitoring` namespace. In the
homelab, Flux should reconcile it as a second `Kustomization` (path
`./deploy/monitoring`) rather than folding it into `apps/sandbox`; by hand,
apply the app first and then the stack:

```bash
kubectl apply -k deploy/talos
kubectl apply -k deploy/monitoring
```

The stack scrapes the three roles on their private `:9100` listener. It does
not create an Ingress and does not expose metrics through the public API
Service. Retention is 14 days and the PVC uses the cluster default
StorageClass; on this cluster that is `standard`.

## What is verified on this cluster

| Check | Command |
| --- | --- |
| Sandboxes run in a VM, not the host kernel | `kubectl exec <pod> -- uname -r` differs from the node's |
| Sandbox pods land only on labelled nodes | `kubectl get pod <pod> -o jsonpath='{.spec.nodeSelector}'` |
| No inbound path to a sandbox | no Service selects sandbox pods; `NetworkPolicy` denies ingress |
| Egress is proxy-only | sandbox cannot resolve DNS; `curl` to a private address fails |
