# Deploying to a real cluster (Talos)

In a Flux-managed deployment this path is **reconciled from a private
repository**; nothing here is applied by hand. Standalone, or to preview exactly
what Flux will apply:

```bash
kubectl kustomize deploy/talos   # render only
kubectl apply -k deploy/talos    # only if you are not running Flux
```

This overlay does **not** create credentials: the base ships no Secrets. The
controller needs `x402-secrets` and `postgres-credentials` in `sandbox-system`
before applying — locally `scripts/dev-secrets.sh` writes both (git-ignored), on
a real deployment they come from your secret store. A private deployment applies
them from its own encrypted secret store.

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

On Talos put this in the machine config (`machine.nodeLabels`) rather than
running `kubectl label`, so a reimage does not silently drop it and leave the
pool unschedulable.

**Label every node you are willing to run hostile code on, and on a small
cluster that is all of them.** A two-node deployment has nowhere else to put a
sandbox, so the etcd node runs tenants too. That is a capacity decision, not a
mistake, but it moves the risk from "is the etcd node labelled" to "can this node
absorb both roles at once". Three numbers decide that.

### 1.1 The memory budget

Sandboxes are scheduled on **requests** and can consume up to their **limits**,
so a node can be fully committed and still oversubscribed in practice. Size the
warm pool against the limits, not the requests:

```text
warm_pods_per_node x memory_limit_per_tier
  + control plane (etcd, apiserver, controller, postgres, api, relay, proxy)
  + 2 GiB headroom
<= node allocatable memory
```

With 12 GiB nodes and a 512 MiB `short` limit, twenty warm pods spread over two
nodes is 5 GiB of limits per node before anything is claimed for the control
plane. That fits, but only if the scheduler spreads them. If the pool is
concentrated on one node, lower `WARM_POOL_BASE_MIN` until the arithmetic works
for a single node, because that is what a drained or cordoned peer produces.

### 1.2 Eviction order

The manifests install two PriorityClasses
([`04-priorityclasses.yaml`](../kubernetes/04-priorityclasses.yaml)):
`sandbox-critical` for Postgres, the API, the controller, the relay, the egress
proxy and the facilitator, and `sandbox-tenant` for every sandbox and warm-pool
pod. A tenant is preempted and evicted before any unclassified workload on the
same node. Without them every pod is priority 0 and the kubelet resolves pressure
by QoS, which is how a busy guest can take the database down with it.

etcd and the apiserver are static pods and are not covered by a PriorityClass.
Protect them with a kubelet reservation instead, in the machine config:

```yaml
machine:
  kubelet:
    extraConfig:
      systemReserved: { cpu: 500m, memory: 1Gi, ephemeral-storage: 2Gi }
      kubeReserved: { cpu: 500m, memory: 512Mi, ephemeral-storage: 2Gi }
      evictionHard: { memory.available: 512Mi, nodefs.available: 10% }
```

### 1.3 Disk

On Talos, etcd's data and `local-path-provisioner`'s volumes both live on the
ephemeral disk. Checkpoint writes are tenant-controlled, and etcd is
fsync-sensitive: sustained write latency shows up as slow API calls, and the
controller holds its leadership through a Kubernetes Lease, so a slow apiserver
turns into leader churn. Two things keep this bounded: the per-tier `diskMiB`
limit, which caps what a checkpoint may write, and, where the hardware allows
it, a separate disk for local-path. If neither is possible, say so in the
deployment notes rather than implying the control plane has isolation it does
not have.

### 1.4 Verify

Verify the runtime is available before deploying, or pods will sit in
`ContainerCreating` forever:

```bash
kubectl get runtimeclass x402-sandbox -o jsonpath='{.handler}{"\n"}'   # expect: kata
talosctl -n <sandbox-node> ls /dev/kvm                                 # expect: kvm
kubectl get priorityclass sandbox-critical sandbox-tenant              # both present
```

## 2. Storage

Checkpointed (suspendable) sessions need a StorageClass named `standard`:

```bash
kubectl get storageclass standard
```

Anything that can provision a `ReadWriteOnce` volume works —
`local-path-provisioner` is enough for a single node. Without it, sessions can
be created and executed but `suspend`/`resume` fails. The Postgres StatefulSet
asks for its own 8 GiB `ReadWriteOnce` volume from the same class, so the store
is node-pinned too: back it up from the database layer, not by copying the
directory ([backup-restore.md](../../docs/backup-restore.md)).

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

Bump `newTag` in `kustomization.yaml` and `GUEST_IMAGE` together, and update
`deploy/release-pins.json` and the Kyverno allowlist in the same change. They are
one release, and `scripts/check-deploy-pins.mjs` fails the build when the overlay,
the map and the allowlist name different ones. That check exists because this overlay once shipped
control 0.1.30 with guest 0.1.25: both tags resolved, and the deployed pair
silently lacked the relay reconnect fix ADR 0012 relies on.

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

The metrics **contract** lives in [`../monitoring`](../monitoring/README.md):
one scrape job for the three roles' private `:9100` listeners, the SLO rules and
the Grafana dashboard. It is tied to the application's metric names, creates no
workload, and is enough for a cluster that already runs Prometheus:

```bash
kubectl create namespace monitoring          # name is load-bearing, see below
kubectl apply -k deploy/monitoring/contract  # three ConfigMaps, no workloads
```

The runnable stack — VictoriaMetrics single-node, vmalert and Grafana — is
cluster-specific and lives in the private deployment repository. Flux reconciles
it there in three ordered steps: namespace, contract, stack. Nothing in this
repository points at those workloads. By hand, apply the app first, then the
namespace, contract and stack:

```bash
kubectl apply -k deploy/talos
# namespace + stack come from the private deployment repository:
#   kubectl apply -k apps/sandbox-monitoring-namespace
#   kubectl apply -k apps/sandbox-monitoring
```

The stack scrapes the three roles on their private `:9100` listener. It does
not create an Ingress and does not expose metrics through the public API
Service. Retention is 14 days and the PVC uses the cluster default
StorageClass; on this cluster that is `standard`. `allow-metrics-scrape` admits
only a namespace named `monitoring` (or `observability`), so the contract's
ConfigMaps must land in one of those.

## What is verified on this cluster

| Check | Command |
| --- | --- |
| Sandboxes run in a VM, not the host kernel | `kubectl exec <pod> -- uname -r` differs from the node's |
| Sandbox pods land only on labelled nodes | `kubectl get pod <pod> -o jsonpath='{.spec.nodeSelector}'` |
| No inbound path to a sandbox | no Service selects sandbox pods; `NetworkPolicy` denies ingress |
| Egress is proxy-only | sandbox cannot resolve DNS; `curl` to a private address fails |
