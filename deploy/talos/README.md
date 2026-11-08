# Deploying to a real cluster (Talos)

```bash
kubectl apply -k deploy/talos
```

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

## 3. Images

`release.yml` publishes two images on a `v*` tag:

| Image | Contents |
| --- | --- |
| `ghcr.io/ejackson-vp/sandbox-control` | api, controller, relay, egress proxy, facilitator |
| `ghcr.io/ejackson-vp/sandbox-guest` | the sandbox runtime that runs inside the microVM |

Bump `newTag` in `kustomization.yaml` and `GUEST_IMAGE` together — they are the
same release.

`GUEST_IMAGE_DIGEST` is left at the dev placeholder deliberately. The controller
only enforces a real `sha256:` digest when `ALLOW_INSECURE_DEV` is false, which
also requires a real payment facilitator. For a production deployment, set the
digest from the release output and turn `ALLOW_INSECURE_DEV` off.

## 4. Public URL

`PUBLIC_BASE_URL` defaults to a placeholder. Set it to the address clients use
to reach the API. With the Tailscale operator this is the MagicDNS name of the
API's `Ingress`, e.g. `https://sandbox.<tailnet>.ts.net`.

## What is verified on this cluster

| Check | Command |
| --- | --- |
| Sandboxes run in a VM, not the host kernel | `kubectl exec <pod> -- uname -r` differs from the node's |
| Sandbox pods land only on labelled nodes | `kubectl get pod <pod> -o jsonpath='{.spec.nodeSelector}'` |
| No inbound path to a sandbox | no Service selects sandbox pods; `NetworkPolicy` denies ingress |
| Egress is proxy-only | sandbox cannot resolve DNS; `curl` to a private address fails |
