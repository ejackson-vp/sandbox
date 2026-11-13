# Monitoring contract

This directory is the **portable** half of the sandbox's monitoring: the scrape
job, the SLO rules, the Grafana dashboard and the documentation for the metric
names they depend on. Everything here is tied to the application, not to a
particular metrics backend — a cluster that already runs a Prometheus can use it
without inheriting VictoriaMetrics.

The runnable stack (VictoriaMetrics single-node, vmalert, Grafana, the
`monitoring` namespace, NetworkPolicies, image pins, retention and Flux wiring)
is cluster-specific and lives in the private GitOps repository
under `apps/sandbox-monitoring/`.

| Part | Where | Why |
| --- | --- | --- |
| Scrape list, SLO rules, dashboard JSON, metric/SLO docs | **here** — `deploy/monitoring/contract/` | Tied to app metric names; portable to any Prometheus-compatible stack |
| VMSingle, vmalert, Grafana, namespace, NetworkPolicies, scrape-config mirror | `apps/sandbox-monitoring/` | Cluster decisions: storage class, retention, resources, image pins |
| Flux ordering | `apps/sandbox-monitoring{,-namespace,-contract}.yaml` | Namespace → contract → stack, so a fresh cluster cannot deadlock |

Nothing in this directory creates a workload. `kubectl apply -k
deploy/monitoring/contract` produces three ConfigMaps in the `monitoring`
namespace and nothing else.

## Scrape contract

One job covers all three control-plane roles. Each role runs one replica in the
reference deployment, so DNS targets are enough; a scaled deployment should switch to pod
discovery with `containerPort: metrics` (the pods already name the port
`metrics`).

| Role | Target | Port |
| --- | --- | --- |
| API | `api.sandbox-system.svc.cluster.local` | `9100` |
| Controller | `controller.sandbox-system.svc.cluster.local` | `9100` |
| Relay | `relay.sandbox-system.svc.cluster.local` | `9100` |

The job adds `role: api|controller|relay`. Every rule and dashboard panel
selects on that label, so it is part of the contract, not a convenience.

The application never exposes `/metrics` on the service listener or the public
ingress: #37 moved it to a dedicated `METRICS_PORT` and made
`allow-metrics-scrape` in
[`../kubernetes/21-networkpolicy-control.yaml`](../kubernetes/21-networkpolicy-control.yaml)
admit only the `monitoring` or `observability` namespace on TCP 9100. Change the
namespace name only together with that policy.

Cardinality is bounded by the application, not by the scraper: routes are
Express templates and failure/close reasons are closed enums, defined in
`shared/src/metrics.ts`. Run the app with `METRICS_STRICT_LABELS=1` when adding
a family to catch an id-shaped label before it reaches storage.

## What the contract directory contains

| File | Contract |
| --- | --- |
| [`contract/prometheus-scrape.yaml`](contract/prometheus-scrape.yaml) | The scrape job, bare-list form for `additionalScrapeConfigs` |
| [`contract/rules/sandbox-slo.yaml`](contract/rules/sandbox-slo.yaml) | Fifteen SLO rules, portable Prometheus/vmalert rule file |
| [`contract/grafana-dashboard.json`](contract/grafana-dashboard.json) | `Sandbox control plane`, uid `sandbox-control-plane` |
| [`contract/kustomization.yaml`](contract/kustomization.yaml) | Renders the three ConfigMaps, namespace `monitoring` |
| [`contract/README.md`](contract/README.md) | How to consume the ConfigMaps, including with an existing Prometheus |

## Runtime profiles and the warm pool

The controller keeps one warm pool per runtime profile (`base`, `python`,
`node`) under one `WARM_POOL_SIZE` budget. Profiles come from
`RUNTIME_PROFILES`; `base` is always present and is the guest image, so it
cannot be redefined. Every profile's pool is independent: a session can only
claim a pod booted from the same profile and image digest.

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `sandbox_warm_pool_budget` | gauge | `profile` | Target idle pods for that profile |
| `sandbox_warm_pool_pods` | gauge | `profile` | Live warm pods: idle plus claimed but not yet relabelled |
| `sandbox_warm_pool_total` | counter | `profile`, `result` | Claim outcomes |
| `sandbox_warm_pool_grow_total` | counter | `profile`, `result` | Growth decisions |
| `sandbox_warm_pool_drain_total` | counter | `profile`, `reason` | Idle drains |
| `sandbox_warm_pool_created_total` | counter | `profile` | Warm pods created |

Claim `result` is one of `hit`, `miss_empty`, `miss_limits`, `miss_profile`,
`miss_error`, `miss_disabled` or `miss_unknown_profile`. Only `miss_empty`
means the profile was under-provisioned. `miss_limits` means the session did
not fit the pool tier and another pod would not help, `miss_profile` means the
request was routed to the wrong pool, `miss_error` is a failed handoff after a
pod was picked, `miss_disabled` means `WARM_POOL_SIZE=0`, and
`miss_unknown_profile` means the request named a runtime this controller does
not run.

Growth `result` is `budget` (spent free budget), `steal` (drained an idle
profile), `cooldown` (inside `WARM_POOL_COOLDOWN_MS`) or `budget_exhausted`
(no free budget and no idle profile above its floor). Drain `reason` is `idle`
today.

### `WARM_POOL_BASE_MIN` and `WARM_POOL_SIZE`

`WARM_POOL_SIZE` is the total idle pods across all profiles. `base` starts at
`min(WARM_POOL_BASE_MIN, WARM_POOL_SIZE)`; `python` and `node` start at zero and
grow only after a `miss_empty` for their profile.

The default for `WARM_POOL_BASE_MIN` is `WARM_POOL_SIZE`, so by default `base`
holds the entire budget. `base` cannot be drained below `WARM_POOL_BASE_MIN`,
which means `python` and `node` have no headroom and every miss records
`budget_exhausted`. Set `WARM_POOL_BASE_MIN` below `WARM_POOL_SIZE` to leave
capacity that language profiles can claim. For example, `WARM_POOL_SIZE=8` and
`WARM_POOL_BASE_MIN=4` gives `base` four pods and four pods of headroom.

`WARM_POOL_SIZE` is not exported as a metric. The allocated part of the budget
is `sum(sandbox_warm_pool_budget)`; it never exceeds `WARM_POOL_SIZE`, and the
remainder is free for growth. Compare that sum to the configured value by hand
or in a recording rule. The `SandboxWarmPoolBudgetExhausted` alert uses the
controller's own `budget_exhausted` decision counter, so it does not need a
total-budget gauge.

A profile needs an idle victim above its floor before its growth can `steal`
capacity. `base`'s floor is its `WARM_POOL_BASE_MIN` target and every language
profile's floor is zero. Capacity is moved one growth step at a time, never
created by a steal.

## Alerts

Rules are in [`contract/rules/sandbox-slo.yaml`](contract/rules/sandbox-slo.yaml).
They are plain Prometheus rule files: Prometheus, vmalert and compatible
evaluators all load them unchanged.

| Alert | Condition | For | Severity |
| --- | --- | --- | --- |
| `SandboxCreateP95High` | create p95 > 500 ms | 10m | warning |
| `SandboxProvisioningTimeoutRateHigh` | provisioning timeouts > 1% of entitlements | 10m | warning |
| `SandboxProvisioningQueueWaitP95High` | queue wait p95 > 5 s | 10m | warning |
| `SandboxRelayPendingRequests` | relay pending > 0 | 5m | warning |
| `SandboxReconcileP95High` | reconcile p95 > 1 s | 10m | warning |
| `SandboxSQLiteBusyRetries` | busy retry rate > 0 | 10m | warning |
| `SandboxReconciliationPending` | create-route 409s > 0 | 5m | warning |
| `SandboxWarmPoolEmpty` | no live pods in any profile while a target exists | 5m | warning |
| `SandboxWarmPoolMissPressure` | `miss_empty` > 20% of hit+miss_empty, at least 20 claims | 15m | warning |
| `SandboxWarmPoolSustainedMisses` | at least 20 `miss_empty` in 15m, per profile | 15m | warning |
| `SandboxWarmPoolUnderTarget` | live pods below target, target > 0, per profile | 15m | warning |
| `SandboxWarmPoolBudgetExhausted` | at least 3 `budget_exhausted` growth decisions in 30m, per profile | 15m | warning |
| `SandboxWarmPoolDrainThrash` | at least 5 idle drains and 5 growths in 1h, per profile | 30m | warning |
| `SandboxMetricsTargetDown` | `up{job="sandbox-control"} == 0` | 2m | critical |
| `SandboxBlastRadius` | controller or relay down with ≥5 relay sessions in the last 15m | 5m | critical |

`SandboxMetricsTargetDown` is the leading indicator: when a process is gone its
application gauges go stale rather than low, so the per-role alerts alone would
miss it. `SandboxBlastRadius` is the rule requested in the issue comments: it
fires once with the affected session count when per-component health is not
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

**Warm-pool rules are gated on an enabled pool.** `SandboxWarmPoolEmpty` is
gated on `sum(sandbox_warm_pool_budget) > 0`, so it stays inactive when
`WARM_POOL_SIZE=0`, the reference deployment default. The profile rules are traffic-gated
instead: with the pool disabled, claims record `miss_disabled`, no profile has
a non-zero target, and none of the expressions match. Enable the pool and set
`WARM_POOL_BASE_MIN` below `WARM_POOL_SIZE` before relying on them.

**Profile alerts aggregate per profile, not per session.** They are rate- or
count-based and held for 15 minutes or longer, so one transient `miss_empty`
cannot fire them. The `for:` windows and thresholds are small-pool starting
points, not capacity-derived numbers. Tune them with a recorded reason.

**The profile rules do not select on `role`.** `sandbox_warm_pool_budget`,
`sandbox_warm_pool_pods`, `sandbox_warm_pool_total`,
`sandbox_warm_pool_grow_total` and `sandbox_warm_pool_drain_total` are
exported only by the controller. Dropping the role selector keeps them working
when a deployment scrapes a single process without a role label. The gauge
aggregations assume one controller replica, as the scrape contract does. If
you run more than one, use `max by (profile)` for
`sandbox_warm_pool_budget` and `sandbox_warm_pool_pods`, and leave the counters
summed.

**The rules do not deliver notifications.** The rule file carries no receiver.
The reference stack evaluates with `-notifier.blackhole`, so alerts are visible as
`ALERTS` series and in the dashboard but nothing pages. Any other deployment is
free to attach its own Alertmanager or webhook bridge without touching these
rules.

## Dashboard

`contract/grafana-dashboard.json` is the #37 dashboard plus a firing-alert
table. Grafana provisions it as `Sandbox / Sandbox control plane` in the
reference deployment; imported by hand elsewhere, it keeps the same uid and title.

The `DS_PROMETHEUS` input is a datasource variable, so the dashboard binds to
whichever Prometheus-compatible datasource the viewer selects. The committed
default is the reference deployment's `vmsingle` uid; pick your own datasource once after
import.

The table at the bottom, **Firing SLO alerts (vmalert)**, queries
`ALERTS{alertstate="firing"}`. It is empty unless the evaluator writes alert
state back to the queried store; vmalert does, a bare Prometheus exposes
`ALERTS` from its own rule evaluation.

Panels 14 to 17 cover the profile warm pools: target against live pods, claim
outcomes, growth decisions and idle drains. They aggregate by `profile`, so
`base`, `python` and `node` stay comparable even though they share one budget.

## Portable usage

### Render and apply the ConfigMaps

```bash
kubectl kustomize deploy/monitoring/contract >/tmp/monitoring-contract.yaml
kubectl apply -k deploy/monitoring/contract    # needs the `monitoring` namespace
```

### Existing Prometheus

- Scrape: merge `sandbox-scrape-configs.yaml` into
  `prometheus.additionalScrapeConfigs` (it is already a bare YAML list).
- Rules: add `rules/sandbox-slo.yaml` to `rule_files`.
- Dashboard: import `contract/grafana-dashboard.json`.

See [`contract/README.md`](contract/README.md) for the ConfigMap keys and a
values snippet.

## Validation

These checks need no cluster:

| Check | Command |
| --- | --- |
| Kustomize render | `kubectl kustomize deploy/monitoring/contract` |
| Rule syntax | `promtool check rules deploy/monitoring/contract/rules/sandbox-slo.yaml` |
| Scrape syntax | `promtool check config` on the extracted `sandbox-scrape-configs.yaml` |
| Dashboard JSON | `python3 -m json.tool deploy/monitoring/contract/grafana-dashboard.json` |
| Dashboard panel ids | `jq -e '([.panels[].id] \| length) == ([.panels[].id] \| unique \| length)' deploy/monitoring/contract/grafana-dashboard.json` |
| YAML parse | `python3 -c 'yaml.safe_load_all(open(...))'` over every file |

Cluster-only checks — scrape targets up, rules loaded, dashboard panels
resolving, PVC bound, steady-state memory — are the stack's responsibility and
are recorded in the reference deployment repository.

## Residual risks (contract side)

- **`reconciliation_pending` is approximate** until the API exports a dedicated
  counter (see [Alert caveats](#alert-caveats)).
- **Warm-pool rules are active only when the pool is enabled.** The reference
  deployment default `WARM_POOL_SIZE=0` keeps them quiet. `WARM_POOL_BASE_MIN` defaults to
  the whole budget, which leaves no headroom for `python` and `node`; set it
  below `WARM_POOL_SIZE` before expecting profile misses to grow a pool.
- **Profile alert thresholds are starting points.** The 20% miss ratio, 20-miss
  volume, three blocked growths and five drains per hour are sized for a small
  pool, not derived from capacity.
- **Blast-radius threshold** of five sessions is a starting point for a
  single-tenant cluster, not a capacity-derived number.
- **The contract names two ConfigMaps after their reference deployment consumers**
  (`vmalert-rules`, `grafana-dashboard-sandbox`). That keeps the live
  installation adoptable without recreation; a downstream consumer that mounts
  the files by path does not care about the names.

Stack risks — no HA, no delivery, root-running upstream images, anonymous
Grafana on a ClusterIP, local-path PVC pinning — are recorded with the stack in
the private GitOps repo, because they follow from the deployment and not from
these files.

## The reference stack

The stack keeps the same namespace, PVC, Deployment and Service names, the same
dashboard uid (`sandbox-control-plane`) and the same scrape targets as before the
split, so adoption did not recreate storage or Services:

- namespace `monitoring`, PVC `vmsingle-data`, Services `vmsingle`, `vmalert`,
  `grafana`, ConfigMaps `sandbox-scrape-config`, `vmsingle-scrape-config`,
  `grafana-datasources`, `grafana-dashboard-provider`, `vmalert-rules`,
  `grafana-dashboard-sandbox`.
- VMSingle and vmalert are tag-pinned together
  (`victoriametrics/*:v1.156.0`); Grafana is `grafana/grafana:13.2.5`.
- 14-day retention, `2Gi` PVC, `Recreate` strategies, ClusterIP only, no
  Ingress, no Alertmanager, no node-exporter, no kube-state-metrics.

The two contract ConfigMaps are named **without** a kustomize content hash
(`generatorOptions.disableNameSuffixHash`), because the stack that mounts them
is a different Kustomization and cannot resolve a hash computed here. That made
the adoption a one-time rollout of `vmalert` and `grafana` when the names changed
from `vmalert-rules-<hash>` / `grafana-dashboard-sandbox-<hash>`; VMSingle and
the scrape path were not restarted. A later content change updates the ConfigMap
in place: Grafana re-reads dashboards every 30 s, vmalert only reloads rules on
restart (or SIGHUP), so restart it after editing the SLO rules.

`vmsingle-scrape-config.yaml` in the stack duplicates the targets here because
VictoriaMetrics needs a full Prometheus document rather than a bare list. Keep
both in sync.
