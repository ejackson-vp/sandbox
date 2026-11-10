# Monitoring (scrape contract only)

The homelab does **not** run a monitoring stack in this repository. These
manifests are the contract for whichever Prometheus/Grafana already exists
(kube-prometheus-stack or a hand-rolled Prometheus):

- `prometheus-scrape.yaml` — one ConfigMap containing a single
  `scrape_configs` list covering API, controller and relay on `:9100`.
- `grafana-dashboard.json` — imports directly into Grafana; the
  `DS_PROMETHEUS` variable is resolved at import time.

This deliberately stops at the scrape contract. Issue #38 owns the stack
itself (Prometheus/Grafana installation, retention, alert routing).

## Apply

```bash
kubectl apply -f deploy/monitoring/prometheus-scrape.yaml
```

Mount the ConfigMap into Prometheus. With kube-prometheus-stack:

```yaml
prometheus:
  prometheusSpec:
    additionalScrapeConfigs:
      name: sandbox-scrape-config
      key: sandbox-scrape-configs.yaml
```

With a plain Prometheus, include the file from `prometheus.yml`:

```yaml
scrape_configs:
  - ...existing jobs...
  # contents of sandbox-scrape-configs.yaml (a list, so this is a merge)
```

## NetworkPolicy

`deploy/kubernetes/21-networkpolicy-control.yaml` adds `allow-metrics-scrape`:
only pods in the `monitoring` (or `observability`) namespace may reach TCP
9100 on `app in (api, controller, relay)`. The metrics listener is bound to the
pod network; the public Service/ingress exposes only the API port 3000.

## Manual check

```bash
kubectl -n monitoring run curl --rm -it --restart=Never --image=curlimages/curl -- \
  curl -s http://controller.sandbox-system.svc.cluster.local:9100/metrics | head
```

The endpoint is also reachable with a port-forward from a trusted workstation:

```bash
kubectl -n sandbox-system port-forward deploy/controller 9100:9100
curl -s http://127.0.0.1:9100/metrics
```

## Dashboard panels

Create rate, ready/reconcile p95, provisioning queue, relay sessions and
pending requests, relay reconnect/disconnect, HTTP p95 by route, HTTP 5xx
ratio, provision failures by reason, SQLite size/WAL and busy retries, plus
event-loop lag and build info.

## Cardinality

Every family is label-bounded. Routes use Express templates
(`/v1/sessions/:id`), never concrete ids; auth/rate-limit/failure reasons are
closed enums in `shared/src/request-metrics.ts` and
`controller/src/store.ts`. `METRICS_STRICT_LABELS=1` enables the same guard the
unit tests use, and it refuses any value that looks like a session id, request
id, capability or opaque token.
