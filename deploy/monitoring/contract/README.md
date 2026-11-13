# The monitoring contract

This directory is the portable half of the monitoring setup. It describes the
application's metrics and is useful with any Prometheus-compatible scraper; it
contains no VictoriaMetrics, Grafana or vmalert workload, no image tag, no
retention period and no PVC.

| File | Contract |
| --- | --- |
| [`prometheus-scrape.yaml`](prometheus-scrape.yaml) | Scrape job and targets, bare-list form |
| [`rules/sandbox-slo.yaml`](rules/sandbox-slo.yaml) | Fifteen SLO rules, portable Prometheus rule file |
| [`grafana-dashboard.json`](grafana-dashboard.json) | `sandbox-control-plane`, uid `sandbox-control-plane` |
| [`README.md`](../README.md) | Metric names, SLO meanings, alert caveats |

The runnable stack — VMSingle, vmalert, Grafana, namespace, NetworkPolicies,
image pins, retention and Flux wiring — is cluster-specific and lives in the
private GitOps repository under `apps/sandbox-monitoring/`.

## Applying it

```bash
kubectl kustomize deploy/monitoring/contract
kubectl apply -k deploy/monitoring/contract    # needs the `monitoring` namespace
```

That creates three ConfigMaps in `monitoring`:

| ConfigMap | Key | Consumer |
| --- | --- | --- |
| `sandbox-scrape-config` | `sandbox-scrape-configs.yaml` | any Prometheus (`additionalScrapeConfigs`, bare list) |
| `vmalert-rules` | `sandbox-slo.yaml` | vmalert (`-rule=.../*.yaml`) or Prometheus (`rule_files`) |
| `grafana-dashboard-sandbox` | `sandbox-control-plane.json` | Grafana file provider |

The names are stable because the reference stack mounts them by name. They are
not a claim that you must run vmalert or Grafana: mount the files wherever
your own stack reads rules and dashboards.

## Using it with an existing Prometheus

The scrape ConfigMap holds a YAML *list*, which is exactly what
kube-prometheus-stack's `additionalScrapeConfigs` expects:

```yaml
# values.yaml
prometheus:
  additionalScrapeConfigs:
    - job_name: sandbox-control
      # ... copy of sandbox-scrape-configs.yaml
```

Rules: copy `rules/sandbox-slo.yaml` next to your other rule files and add it
to `rule_files`. `promtool check rules` must stay green.

Dashboard: import `grafana-dashboard.json` (or drop it in a provisioned
directory). Its `DS_PROMETHEUS` input is a datasource variable, so it binds to
whichever Prometheus-compatible datasource you select; the committed default
is the reference deployment's `vmsingle` uid.

## Keeping the two forms in step

VMSingle needs a full document (`global:` + `scrape_configs:`), not a bare
list, so the reference stack keeps a mirror at
`apps/sandbox-monitoring/vmsingle-scrape-config.yaml`. Change the targets and
labels in both places — the `role` label (`api`, `controller`, `relay`) is
load-bearing for every rule and dashboard panel.
