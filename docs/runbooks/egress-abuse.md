# Runbook — egress abuse

Use when a session is using the egress proxy for something you do not want:
exfiltration, scanning, spam, a compromised workload, or a complaint from an
upstream host. The proxy is the only path a sandbox has to the internet
([networking.md](../networking.md)), so containment is a decision about one
session, not about the cluster.

## What the proxy already stops

| Control | Default | Where |
| --- | --- | --- |
| `CONNECT` only, port 443 only | enforced | `EGRESS_ALLOWED_PORTS` |
| Destination must be entirely public | enforced | `EGRESS_DENIED_CIDRS`, `classifyAddress` |
| Per-session concurrent tunnels | 16 | `EGRESS_MAX_CONNECTIONS_PER_SESSION` |
| Global concurrent tunnels | 512 | `EGRESS_MAX_GLOBAL_CONNECTIONS` |
| Per-session bytes, both directions | 1 GiB | `EGRESS_MAX_BYTES_PER_SESSION` |
| Global bytes per window | 20 GiB / 1 h | `EGRESS_MAX_BYTES_GLOBAL_WINDOW`, `EGRESS_BYTES_WINDOW_MS` |
| Per-session HMAC token | enforced | `PROXY_TOKEN_SECRET` |
| Hostname allowlist | **off** | `EGRESS_ALLOWED_HOST_SUFFIXES` |

A byte bound is hard, not a throttle: a chunk that would cross either one
destroys the tunnel, and the session sees the socket close mid-stream. `0`
disables either bound.

The allowlist is the only control that limits *where* a session goes, and it
ships disabled ([production-readiness.md](../production-readiness.md) §2).

## Detect

Volume is a metric now. The alert catches the process total; a single session
that is under the global budget but obviously abusive is still a log question,
because no metric carries a session id.

| Signal | Where | Means |
| --- | --- | --- |
| `sandbox_egress_limit_total{scope}` | proxy metrics | a tunnel was destroyed by a byte bound (`session` or `global`) |
| `sandbox_egress_bytes_total{scope}` | proxy metrics | bytes moved, charged to each bound (select one scope, never sum) |
| `SandboxEgressLimitRejections` alert | vmalert | any byte refusal in the last 15 minutes |
| `SandboxEgressBytesNearCap` alert | vmalert | above 75% of the global hourly budget |
| `egress_allowed` lines per session per hour | proxy log | which session, once the alert says there is one |
| `egress_denied` lines | proxy log | a client trying something the proxy refuses |
| `bytes` and `active` in `/stats` | proxy, in memory | current process totals, all sessions |
| `sandbox_egress_cross_shard_total` | proxy metrics | session sent to the wrong proxy replica |

The proxy is not one of the three scrape targets in
`deploy/monitoring/contract/prometheus-scrape.yaml`, so its metrics are only
visible if you add `egress-proxy.sandbox-system.svc.cluster.local:9100` as a
target or read them by port-forward.

```bash
kubectl -n sandbox-system port-forward deploy/egress-proxy 13128:3128 &
curl -s http://127.0.0.1:13128/stats
```

Expected, all sessions together:

```json
{"ok":true,"active":3,"denied":41,"allowed":9182,"bytes":7340032}
```

`denied` and `allowed` are counts of tunnel attempts and `bytes` is tunnelled
payload in both directions, all cumulative for the process, so they reset on
restart. `/stats` is the process total only: it carries no session id, which is
why the alert leads to the log rather than to a tenant.

Denials grouped by session, reason and destination:

```bash
kubectl -n sandbox-system logs deploy/egress-proxy --since=1h \
  | jq -r 'select(.msg=="egress_denied") | [.sessionId // "-", .reason, .host // "-"] | @tsv' \
  | sort | uniq -c | sort -rn | head -20
```

```text
  184  sbx_3f9c1a77e204  too_many_connections      example.com
   22  sbx_3f9c1a77e204  blocked_destination:private  -
    4  -                  proxy_authentication_failed  -
```

Allowed destinations grouped by session:

```bash
kubectl -n sandbox-system logs deploy/egress-proxy --since=1h \
  | jq -r 'select(.msg=="egress_allowed") | [.sessionPrefix, .host] | @tsv' \
  | sort | uniq -c | sort -rn | head -20
```

`sessionPrefix` is the first 12 characters of the session id (`sbx_` plus 8).
Resolve it against the live pod labels:

```bash
kubectl -n sandbox-workloads get pods -l app.kubernetes.io/name=x402-sandbox \
  -o custom-columns=ID:.metadata.labels.x402\\.io/session,POD:.metadata.name
```

## Contain

Ordered by blast radius. Do the first one unless the destination itself is the
problem.

1. **Kill the session.** The proxy token is bound to the session id and dies
   with it, so there is nothing to revoke separately.

   ```bash
   kubectl -n sandbox-system port-forward deploy/controller 13001:3001 &
   ADMIN=$(kubectl -n sandbox-system get secret x402-secrets \
     -o jsonpath='{.data.admin-token}' | base64 -d)
   curl -s -X DELETE -H "x-internal-token: $ADMIN" \
     http://127.0.0.1:13001/internal/sessions/sbx_3f9c1a77e204
   ```

   Expected `{"state":"READY"}` (the state at the moment of the request). The
   reconciler moves it to `TERMINATING` within one tick (250 ms by default), and
   the pod and workspace PVC are deleted on the same pass.

2. **Deny the destination cluster-wide.** For an active exfiltration where the
   session has not been identified yet, add a Cilium egress deny for the
   destination CIDR/FQDN on the `sandbox-workloads` namespace. This is a blunt
   instrument: it affects every tenant and needs cluster-admin.

3. **Turn on the allowlist.** Set `EGRESS_ALLOWED_HOST_SUFFIXES` in the
   controller config and roll the proxy. Refused hosts return
   `403 host_not_allowlisted`. Only do this if you can name the suffixes every
   tenant needs; a wrong list is a fleet-wide outage.

Per-session destination blocking is **not** implemented. If that is the control
you need, it is a new feature, not a runbook step.

## Recover

- **Refund:** an abuse takedown is not refundable. The refund policy only covers
  a settled session that never reached READY (`controller/src/refunds.ts`); a
  session you killed while READY records `not_applicable`, and real payment modes
  do not execute refunds anyway (F-10). If you decide to refund out of policy,
  it is a manual transfer and needs a ledger note.
- **Capacity:** termination releases the reservation; confirm with
  `curl -s -H "x-internal-token: $ADMIN" http://127.0.0.1:13001/internal/capacity`
  and check that `reservations.held` and `reservations.allocated` fell by one.
- **Payer:** if the same payer reconnects, the per-payer rate limiter is the only
  durable-ish control, and it is per-replica and in memory
  (`sandbox_rate_limited_total{scope="payer"}`). There is no blocklist. A
  repeat offender needs the allowlist or a payment-level decision.
- **Byte refusal:** a byte refusal destroys the tunnel, not the session. The
  guest keeps running and can open another tunnel, which is refused again if the
  per-session total is exhausted; the session ends only at its lease or when you
  kill it. If a legitimate session was cut off, `EGRESS_MAX_BYTES_PER_SESSION`
  is the bound to raise (roll the proxy, not the controller), and the recorded
  reason should say what the download was. Raising it for one session is not
  possible: the bound is per process, keyed by the session id in memory.

## Verify

1. The session is gone and no pod or PVC remains:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -H "x-internal-token: $ADMIN" \
     http://127.0.0.1:13001/internal/sessions/sbx_3f9c1a77e204
   kubectl -n sandbox-workloads get pods,pvc -l x402.io/session=sbx_3f9c1a77e204
   ```

   Expected `404` and `No resources found`.

2. No new `egress_allowed` line carries the session prefix:

   ```bash
   kubectl -n sandbox-system logs deploy/egress-proxy --since=5m \
     | jq -r 'select(.msg=="egress_allowed" and .sessionPrefix=="sbx_3f9c1") | .host'
   ```

   Expected: no output.

3. If you enabled the allowlist, one refused attempt proves it is live: a
   `403 host_not_allowlisted` in the proxy log from a test session.

## Preserve evidence

Capture before the pod and PVC are deleted. The proxy log is the primary record
and it is lost when the proxy pod restarts.

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "incident-$STAMP"
kubectl -n sandbox-system logs deploy/egress-proxy --since=6h \
  > "incident-$STAMP/proxy.log"
curl -s http://127.0.0.1:13128/stats > "incident-$STAMP/proxy-stats.json"
curl -s -H "x-internal-token: $ADMIN" \
  http://127.0.0.1:13001/internal/sessions/sbx_3f9c1a77e204 \
  > "incident-$STAMP/session.json"
kubectl -n sandbox-workloads get pod -l x402.io/session=sbx_3f9c1a77e204 -o yaml \
  > "incident-$STAMP/pod.yaml"
```

Record with the evidence: the UTC window, the session id and payer address, the
destinations, the deny reasons, and what you changed (option 1, 2 or 3).

The workspace PVC is plaintext ([ADR 0007](../adr/0007-checkpoint-at-rest-plaintext.md)).
Copy it only if the case needs the files, store it encrypted, and delete it when
the case closes.

## Known gaps

- The byte budgets are process-local, like the connection counters beside them.
  A second proxy replica multiplies each budget by the replica count; the shard
  claim in the token stops a session being served by the wrong replica, and it
  does not pool the budgets.
- The per-session total is per process lifetime and is never evicted, so a very
  long-lived proxy holds one map entry per session it has served. A restart
  resets both totals.
- No per-session destination blocklist; the only per-session control is killing
  the session.
- Denials from an unverifiable token have no session id, by construction, and
  the byte-limit log line deliberately carries only the scope.
- The proxy is not one of the three scrape targets, so the two egress alerts
  need a target added before they evaluate (see Detect).

## Related

- [networking.md](../networking.md) — the policy that makes the proxy the only path
- [orphan-storage.md](orphan-storage.md) — cleanup if the kill leaves a PVC behind
- [tabletop.md](tabletop.md) — exercise that walks this runbook
