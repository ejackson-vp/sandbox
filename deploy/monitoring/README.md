# Monitoring stack

This directory used to hold only the scrape contract from #37. It now ships a
complete, versioned stack for the two-node homelab: **VictoriaMetrics
single-node + Grafana + vmalert**. There is still no Prometheus, no
Alertmanager, no kube-state-metrics and no node-exporter.

The stack scrapes the three control-plane roles on their private `:9100`
listener, stores 14 days of samples, provisions the existing
[`grafana-dashboard.json`](grafana-dashboard.json), and evaluates the SLO rules
in [`rules/sandbox-slo.yaml`](rules/sandbox-slo.yaml).

## Why this stack

A full kube-prometheus-stack is five or six pods (Prometheus, Alertmanager,
Grafana, kube-state-metrics, node-exporter, often a sidecar) plus CRDs and a
large default rule set. On two nodes that spends more memory and operational
attention than the service it watches.

| Option | Decision |
| --- | --- |
| VictoriaMetrics single-node + Grafana + vmalert | **Chosen.** One storage/scrape process, PromQL-compatible, ~100–200 MiB steady state, one PVC. |
| Prometheus agent + remote store | A second store is still required; no gain at this size. |
| Grafana Alloy → local Prometheus | More moving parts than one VMSingle process; Prometheus is heavier than VMSingle for the same series. |
| kube-prometheus-stack | Rejected: too many pods and CRDs for a two-node homelab. |

The deliberate trade-off is no HA. One VMSingle pod, one Grafana pod and one
vmalert pod; if the node they run on is lost, metrics and dashboards are gone
until it returns. That is acceptable for observability metadata; it is not a
system of record.

## What is deployed

| File | Contents |
| --- | --- |
| [`namespace.yaml`](namespace.yaml) | `monitoring` namespace, baseline Pod Security. |
| [`vmsingle.yaml`](vmsingle.yaml) | VMSingle Deployment, `vmsingle-data` PVC, ClusterIP Service. |
| [`vmsingle-scrape-config.yaml`](vmsingle-scrape-config.yaml) | Full `scrape.yml` for VMSingle, all three roles on `:9100`. |
| [`prometheus-scrape.yaml`](prometheus-scrape.yaml) | The #37 bare-list contract, kept for an existing Prometheus. |
| [`vmalert.yaml`](vmalert.yaml) | vmalert Deployment and ClusterIP Service. |
| [`rules/sandbox-slo.yaml`](rules/sandbox-slo.yaml) | Portable Prometheus/vmalert SLO rules. |
| [`grafana.yaml`](grafana.yaml) | Stateless Grafana Deployment and ClusterIP Service. |
| [`grafana/datasources.yaml`](grafana/datasources.yaml) | Provisioned VictoriaMetrics datasource (`uid: vmsingle`). |
| [`grafana/dashboards.yaml`](grafana/dashboards.yaml) | File-based dashboard provider. |
| [`grafana-dashboard.json`](grafana-dashboard.json) | The #37 dashboard plus a firing-alert table. |
| [`networkpolicy.yaml`](networkpolicy.yaml) | Egress limits for the monitoring pods. |

Images are tag-pinned, not `latest`:

| Component | Image | Retention / config |
| --- | --- | --- |
| VictoriaMetrics | `victoriametrics/victoria-metrics:v1.156.0` | `-retentionPeriod=14d`, PVC `2Gi` |
| vmalert | `victoriametrics/vmalert:v1.156.0` | `-evaluationInterval=30s`, `-notifier.blackhole` |
| Grafana | `grafana/grafana:13.2.5` | Dashboards and datasources provisioned from ConfigMaps |

Bump the two VictoriaMetrics tags together. They are released from the same
tree and the rule/datasource HTTP surface is shared.

## Resource budget

Requests are deliberately small; limits leave headroom for a scrape burst and
Grafana's first render.

| Pod | CPU request / limit | Memory request / limit | Estimated steady state |
| --- | --- | --- | --- |
| `vmsingle` | `100m` / `500m` | `128Mi` / `512Mi` | ~100–200 MiB |
| `vmalert` | `25m` / `200m` | `64Mi` / `192Mi` | ~40–70 MiB |
| `grafana` | `50m` / `300m` | `128Mi` / `384Mi` | ~150–220 MiB |
| **Total** | **`175m` / `1000m`** | **`320Mi` / `1088Mi`** | **~290–490 MiB** |

Storage: roughly 600 active series (three targets times the bounded families
in `shared/src/metrics.ts`), 15 s scrapes and 14 days is on the order of
100–300 MB before compaction headroom. The `2Gi` PVC is intentionally larger
than the estimate.

These are **estimates from the process baselines and the expected series
count**, not measurements from a live homelab. Measuring RSS with
`kubectl top pod -n monitoring` after a day is a cluster-only step; see
[Validation](#validation-and-what-remains-cluster-only). Do not quote the
table as a measurement.

## Apply

### Render first

```bash
kubectl kustomize deploy/monitoring >/tmp/monitoring.yaml
```

### By hand (portable Kubernetes)

```bash
kubectl get storageclass        # the PVC uses the cluster default
kubectl apply -k deploy/monitoring
kubectl -n monitoring rollout status deploy/vmsingle deploy/vmalert deploy/grafana
```

If the cluster has no default StorageClass, set `storageClassName` in
[`vmsingle.yaml`](vmsingle.yaml) before applying. The homelab's local-path
provisioner exposes `standard`; a cluster with a different default needs no
change. The PVC is `ReadWriteOnce`, so the VMSingle pod is pinned to whichever
node first binds it — expected for a single-node metrics store.

The app deployment does **not** depend on this directory. Apply
`deploy/talos` (or `deploy/kata`) as before; monitoring is a separate overlay
because a metrics store has a different lifecycle and can be removed without
touching tenant sessions.

### Homelab / Flux

This is the only homelab-specific part. The homelab reconciles the service
from `ejackson-vp/homelab`; add a second Flux `Kustomization` that points at
this path in the same source repository:

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: sandbox-monitoring
  namespace: flux-system
spec:
  interval: 10m
  path: ./deploy/monitoring
  prune: true
  sourceRef:
    kind: GitRepository
    name: sandbox
```

Do not fold it into the existing `apps/sandbox` Kustomization if that
Kustomization has a `targetNamespace` other than `monitoring`; this directory
sets `namespace: monitoring` itself. The manifests are plain Kubernetes and do
not use Flux CRs, so the same directory applies with `kubectl apply -k`
anywhere.

## Scrape contract

Both scrape files target the same three private listeners:

| Role | Target | Port |
| --- | --- | --- |
| API | `api.sandbox-system.svc.cluster.local` | `9100` |
| Controller | `controller.sandbox-system.svc.cluster.local` | `9100` |
| Relay | `relay.sandbox-system.svc.cluster.local` | `9100` |

The scrape job adds `role: api|controller|relay`. The application never exposes
`/metrics` on the service listener or the public ingress; #37 moved it to a
dedicated `METRICS_PORT` and made `allow-metrics-scrape` in
[`../kubernetes/21-networkpolicy-control.yaml`](../kubernetes/21-networkpolicy-control.yaml)
admit only the `monitoring` or `observability` namespace on TCP 9100.

Keep [`prometheus-scrape.yaml`](prometheus-scrape.yaml) and
[`vmsingle-scrape-config.yaml`](vmsingle-scrape-config.yaml) in sync. The
first is a bare list for kube-prometheus-stack's `additionalScrapeConfigs`; the
second is the full document VMSingle needs. They are duplicated because the two
formats cannot share one ConfigMap key without an init container.

## Dashboard

Grafana provisions the existing dashboard as `Sandbox / Sandbox control plane`.
The `DS_PROMETHEUS` variable is pre-selected to the `vmsingle` datasource uid,
so provisioned panels resolve without a click. The added table at the bottom,
**Firing SLO alerts (vmalert)**, queries `ALERTS{alertstate="firing"}` and shows
the rules vmalert has evaluated.

Access is operator-only:

```bash
kubectl -n monitoring port-forward svc/grafana 3000:3000
# http://127.0.0.1:3000
```

There is no Ingress and no LoadBalancer. Grafana runs with anonymous **Viewer**
access and the login form disabled; provisioning is the only way to change a
dashboard. Anyone who can reach the ClusterIP can read the dashboards, so keep
the namespace and NetworkPolicy boundary intact.

## Alerts

Rules live in [`rules/sandbox-slo.yaml`](rules/sandbox-slo.yaml) and are
evaluated by vmalert against VMSingle. vmalert writes `ALERTS` and
`ALERTS_FOR_STATE` back to VMSingle; that is what the dashboard table reads.

| Alert | Condition | For | Severity |
| --- | --- | --- | --- |
| `SandboxCreateP95High` | create p95 > 500 ms | 10m | warning |
| `SandboxProvisioningTimeoutRateHigh` | provisioning timeouts > 1% of entitlements | 10m | warning |
| `SandboxProvisioningQueueWaitP95High` | queue wait p95 > 5 s | 10m | warning |
| `SandboxRelayPendingRequests` | relay pending > 0 | 5m | warning |
| `SandboxReconcileP95High` | reconcile p95 > 1 s | 10m | warning |
| `SandboxSQLiteBusyRetries` | busy retry rate > 0 | 10m | warning |
| `SandboxReconciliationPending` | create-route 409s > 0 | 5m | warning |
| `SandboxWarmPoolEmpty` | warm pool pods == 0 | 5m | warning |
| `SandboxMetricsTargetDown` | `up{job="sandbox-control"} == 0` | 2m | critical |
| `SandboxBlastRadius` | controller or relay down with ≥5 relay sessions in the last 15m | 5m | critical |

`SandboxMetricsTargetDown` is the leading indicator: when a process is gone its
application gauges go stale rather than low, so the per-role alerts alone would
miss it. `SandboxBlastRadius` is the rule requested in the issue comments: it
pages once with the affected session count when per-component health is not
enough to describe tenant impact.

### Alert caveats

**`reconciliation_pending` is currently a proxy.** The API documents a `409
reconciliation_pending` response but does not export a per-error-code counter.
`SandboxReconciliationPending` therefore counts every 409 on the create route,
which also includes `payment_in_progress`, `spec_mismatch`,
`entitlement_missing` and non-retryable capacity conflicts. It is still useful
(sustained 409s are never healthy), but it is not a precise reconciliation
backlog. When the API exports a dedicated bounded counter, replace the
expression and narrow the rule.

**`SandboxWarmPoolEmpty` is inactive when the pool is disabled.** The controller
exports `sandbox_warm_pool_pods` only when `WARM_POOL_SIZE > 0`; the homelab
default is `0`. The rule is intentionally written so an absent series does not
fire. Enable the pool before relying on it.

**There is no pager in this stack.** vmalert runs with `-notifier.blackhole`,
so it evaluates, stores state and leaves delivery alone. To page, replace that
flag with `-notifier.url=<alertmanager-or-webhook-bridge>` and configure a
receiver; the rule file itself does not change.

## Validation and what remains cluster-only

Checked in this change, without a cluster:

| Check | Command | Result |
| --- | --- | --- |
| Kustomize render | `kubectl kustomize deploy/monitoring` | passes, 17 YAML documents |
| Rule syntax | `promtool check rules deploy/monitoring/rules/sandbox-slo.yaml` and `vmalert -dryRun -rule=...` | 10 rules, success |
| Scrape config syntax | `promtool check config` on both scrape documents | success |
| YAML parse | `python3 -c 'yaml.safe_load_all(...)'` over every file and embedded ConfigMap document | passes |
| Dashboard JSON | `python3 -m json.tool deploy/monitoring/grafana-dashboard.json` | passes |
| Image tag exists | `crane digest <image>` for all three pinned tags | resolves |
| Markdown | `npx markdownlint-cli2` over the changed Markdown | passes |

**Not done, because no live cluster was available:** applying the manifests,
scraping a real process, binding the PVC, enforcing the NetworkPolicy, firing a
synthetic alert, and measuring steady-state memory. `kubectl apply
--dry-run=client` also cannot validate against this workstation's API server
(no reachable cluster/OpenAPI), so the render and schema-independent checks
above are the limit here.

Cluster-only checks, in order:

1. `kubectl -n monitoring get pods,pvc` — all three pods `Running`, PVC `Bound`.
2. `kubectl -n monitoring port-forward svc/vmsingle 8428:8428`, then
   `curl -s localhost:8428/api/v1/targets | jq '.data.activeTargets[].labels.role'`
   — expect `api`, `controller`, `relay`, all `up`.
3. Open Grafana and confirm every panel has data and the datasource variable
   resolves to `vmsingle`.
4. `kubectl -n monitoring port-forward svc/vmalert 8880:8880`, then
   `curl -s localhost:8880/api/v1/rules | jq` — 10 rules loaded, no parse errors.
5. Synthetic failure on a disposable cluster: scale the relay to zero
   (`kubectl -n sandbox-system scale deploy/relay --replicas=0`), wait more than
   two minutes, and check `curl -s localhost:8880/api/v1/alerts`. Expect
   `SandboxMetricsTargetDown`; with at least five previously registered sessions
   also expect `SandboxBlastRadius` after five minutes. Scaling the relay drops
   in-flight sessions, so do this only on a test deployment. This was **not**
   run for this change and no claim is made that an alert fired.
6. Leave the stack for 24 hours and record `kubectl top pod -n monitoring`; use
   that measurement, not the estimate table, as the steady-state figure.

## Operations

- **Retention** is 14 days. Increase `-retentionPeriod` and the PVC together;
  do not set it above 14 days without checking free space on the node.
- **Upgrades** are a `Recreate` of one pod. VMSingle keeps the PVC; Grafana is
  stateless and reprovisions from ConfigMaps.
- **Backups** are not included. Metrics are disposable; if you need them longer
  than the PVC or the node survives, add `vmbackup` to object storage or raise
  retention. Do not treat this as a system of record.
- **Cardinality** is bounded by the application, not by this stack. Routes are
  Express templates and failure/close reasons are closed enums. Run the app
  with `METRICS_STRICT_LABELS=1` when adding a family to catch an id-shaped
  label before it reaches storage.
- **No node metrics**: kube-state-metrics and node-exporter are omitted. The
  dashboard's capacity panels read the controller's own
  `sandbox_capacity_*` gauges. Add node-exporter only when a node-saturation
  panel is actually needed; that is another DaemonSet on both nodes.

## Portability

| Part | Portable Kubernetes | Homelab / Flux-specific |
| --- | --- | --- |
| Namespace, Deployments, Services, PVC, NetworkPolicies | Yes | — |
| `kubectl apply -k deploy/monitoring` | Yes | — |
| Dashboard, datasource and rule provisioning | Yes | — |
| StorageClass | Uses the cluster default; set it if there is none | Homelab default is `standard` |
| Flux `Kustomization` | — | Path in the homelab repo, source name and reconciliation interval |
| Private `:9100` scrape / `allow-metrics-scrape` | Yes, provided the monitoring namespace keeps its name | Homelab applies the app overlay separately |
| Pod Security | Baseline; VM and vmalert run as upstream root | Adjust for a restricted cluster |
| Ingress | None | None; port-forward only |

## Residual risks

- **No HA.** Losing the node that holds the VMSingle PVC loses history and
  dashboards until it is rescheduled. Local-path PVCs cannot move between nodes.
- **No notifications.** Alerts are evaluated and visible, but no page is sent
  until a notifier is configured.
- **`reconciliation_pending` is approximate** until the API exports a dedicated
  counter (see [Alert caveats](#alert-caveats)).
- **Warm-pool alert is off** while the homelab default `WARM_POOL_SIZE=0`.
- **Blast-radius threshold** of five sessions is a starting point for a
  single-tenant homelab, not a capacity-derived number.
- **Memory figures are estimates.** The acceptance criterion to measure them is
  cluster-only.
- **VMSingle and vmalert run as root** because their upstream images have no
  unprivileged user. They have no host mounts, drop all capabilities and use
  the default seccomp profile; a stricter image or an init-time `chown` is the
  next hardening step if Pod Security moves to `restricted`.
- **Grafana is anonymous Viewer on a ClusterIP.** This is intentional for an
  operator dashboard with no ingress, but any pod in the cluster can read it.
