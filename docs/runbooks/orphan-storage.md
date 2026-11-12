# Runbook — orphan Pod or PVC

Use when a Pod or workspace PVC in `sandbox-workloads` has no live session: a
controller crash mid-create, a failed deletion, a database restore, or a killed
API. The reaper owns this normally; this runbook is for when it is stuck, or
when you must clean up before it runs.

## What exists and who owns it

| Object | Name | Labels | Owner |
| --- | --- | --- | --- |
| sandbox Pod | `sbx-<id>` | `x402.io/session`, `x402.io/pool=sandbox` | session row, then the reaper |
| warm Pod | `warm-<id>` | `x402.io/pool=warm`, `x402.io/warm-id` | warm pool manager |
| workspace PVC | `x402-ws-<id>` | `x402.io/session`, `x402.io/pool=workspace` | session row, then the sweeper |

The reaper deletes a Pod when its session is terminal or missing, or when the
Pod is older than `MAX_POD_AGE_MS` (1 h), and deletes a PVC when its session is
terminal, missing (`no_session`) or unattributable (`unattributed`) and older
than `ORPHAN_PVC_GRACE_MS` (1 h). Both run on the slow housekeeping tick, not the
reconcile tick.

## Detect

No orphan alert is implemented ([production-readiness.md](../production-readiness.md)
§3). Use the comparison below.

```bash
# Pods in the workload namespace, by pool
kubectl -n sandbox-workloads get pods \
  -l app.kubernetes.io/name=x402-sandbox \
  -o custom-columns=POOL:.metadata.labels.x402\\.io/pool,ID:.metadata.labels.x402\\.io/session,AGE:.metadata.creationTimestamp \
  | sort

# Active sessions as the controller sees them
kubectl -n sandbox-system port-forward deploy/controller 19100:9100 &
curl -s http://127.0.0.1:19100/metrics | grep -E 'sandbox_sessions_active|sandbox_capacity_reserved_cpu'
```

```text
# HELP sandbox_sessions_active Sessions in READY or ACTIVE
# TYPE sandbox_sessions_active gauge
sandbox_sessions_active 4
```

`pool=sandbox` Pods minus `sandbox_sessions_active` is the orphan count. A warm
Pod is not an orphan: `pool=warm` is expected to exceed zero when
`WARM_POOL_SIZE > 0`.

Supporting signals:

| Signal | Means |
| --- | --- |
| `sandbox_workspace_pvcs_reaped_total{reason}` | the sweeper is working; reasons are `terminal_session`, `no_session`, `unattributed` |
| `workspace_pvc_reap_failed` log | deletion attempted, API refused; usually a finalizer |
| `orphan_pod_delete_failed` log | same for Pods |
| `sandbox_reservation_leaks_detected_total` | a reservation has been stuck in `RELEASING` for over a minute: Pod deletion is failing |
| `sandbox_capacity_reserved_cpu_millicores` | capacity still held by those reservations |

```bash
kubectl -n sandbox-system logs deploy/controller --since=1h \
  | jq -r 'select(.msg|test("orphan_pod|workspace_pvc")) | [.msg, .podName // .pvc // "-", .sessionId // "-", .reason // .error // "-"] | @tsv'
```

## Triage

For each candidate, ask the controller rather than the cluster: the database is
the authority on whether a session is live.

```bash
ADMIN=$(kubectl -n sandbox-system get secret x402-secrets \
  -o jsonpath='{.data.admin-token}' | base64 -d)
kubectl -n sandbox-system port-forward deploy/controller 13001:3001 &

curl -s -H "x-internal-token: $ADMIN" \
  http://127.0.0.1:13001/internal/sessions/sbx_3f9c1a77e204 | jq '{sessionId,state,destroyedAt,failureCode}'
```

| Answer | Meaning | Action |
| --- | --- | --- |
| `404` | no row: the Pod/PVC was never attributed or the row is gone | delete it (§Contain) |
| `state` in `DESTROYED`/`EXPIRED`/`FAILED` | terminal, cleanup did not finish | delete it, then check the reservation |
| `state` in `READY`/`ACTIVE` | live | **do not delete**. The Pod is serving a paid session |

A `READY` session whose Pod is missing is the opposite problem (a lost Pod, not
an orphan): the reconciler will fail the session. Do not clean up by hand; let it
reconcile, and check `sandbox_sessions_failed_total{reason}` afterwards.

## Contain

Deleting the object is the containment; there is no state to preserve in the
controller, because the reaper's rules are the same ones you are applying.

1. **Revoke the session first**, if a row exists, so the controller cannot
   recreate or later claim the Pod:

   ```bash
   curl -s -X DELETE -H "x-internal-token: $ADMIN" \
     http://127.0.0.1:13001/internal/sessions/sbx_3f9c1a77e204
   ```

2. **Delete the Pod and PVC.** Use `--wait=false` so one stuck object does not
   block the rest, then re-check:

   ```bash
   kubectl -n sandbox-workloads delete pod sbx-3f9c1a77e204 --wait=false
   kubectl -n sandbox-workloads delete pvc x402-ws-3f9c1a77e204 --wait=false
   ```

3. **Clear a finalizer only if it is the blocker.** `kubectl get pvc` showing
   `Terminating` for more than a minute with no `kubernetes.io/pvc-protection`
   reason means a storage finalizer is stuck. That is a storage-layer problem;
   removing the finalizer by hand can leak the backing volume. Escalate instead.

## Recover

- **Capacity:** a deleted Pod with no session row can leave an `ALLOCATED`
  reservation. Compare before and after:

  ```bash
  curl -s -H "x-internal-token: $ADMIN" http://127.0.0.1:13001/internal/capacity \
    | jq '.reservations, .reserved'
  ```

  `held` + `allocated` + `suspended` should match the number of non-terminal
  sessions. A mismatch that survives two housekeeping ticks is a reservation
  leak. `sandbox_reservation_recovery_total{kind}` shows the recovery path
  firing (`terminal_session`, `released_pod_gone`); if it stays flat and
  `sandbox_reservation_leaks_detected_total` climbs, the Pod object is still
  there and the Kubernetes API is refusing the delete. Restart the controller
  only if the recovery path is not firing. A restart is safe for the ledger (the
  store is Postgres behind the same port;
  [ADR 0010](../adr/0010-controller-ha-storage.md)) but it interrupts live
  sessions.
- **PVC-full:** if the node is out of disk because of accumulated volumes, list
  them with sizes and delete the oldest terminal ones first. `local-path` keeps
  the data on the node, so deletion is what frees it.

## Verify

```bash
kubectl -n sandbox-workloads get pods,pvc -l x402.io/session=sbx_3f9c1a77e204
```

Expected `No resources found`. Then:

- `sandbox_sessions_active` equals the number of `pool=sandbox` Pods;
- `sandbox_workspace_pvcs_reaped_total` did not jump again for the same object
  (a jump means the sweep is fighting something);
- no new `orphan_pod_delete_failed` or `workspace_pvc_reap_failed` line for that
  name.

## Preserve evidence

An orphan is usually a symptom, so capture why before deleting.

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "incident-$STAMP"
kubectl -n sandbox-workloads get pod sbx-3f9c1a77e204 -o yaml > "incident-$STAMP/pod.yaml"
kubectl -n sandbox-workloads get pvc x402-ws-3f9c1a77e204 -o yaml > "incident-$STAMP/pvc.yaml"
kubectl -n sandbox-system logs deploy/controller --since=6h > "incident-$STAMP/controller.log"
curl -s -H "x-internal-token: $ADMIN" \
  http://127.0.0.1:13001/internal/sessions/sbx_3f9c1a77e204 \
  > "incident-$STAMP/session.json"
```

The PVC holds the customer's filesystem in plaintext
([ADR 0007](../adr/0007-checkpoint-at-rest-plaintext.md)). Do not copy the
contents unless the case needs them, and delete the copy when it closes.

## Known gaps

- No orphan Pod or orphan PVC alert, so detection is manual.
- The reaper's only observable is a counter and a log line; there is no gauge of
  "objects with no owner".
- The sweep runs on a slow housekeeping tick; a controller that is down does not
  reap at all, so orphans accumulate silently during a control-plane outage.

## Related

- [sessions.md](../sessions.md) — states and what owns a Pod
- [lifecycle.md](../lifecycle.md) — checkpoint volumes and their retention
- [capacity-model.md](../capacity-model.md) — reservations and accounting
- [tabletop.md](tabletop.md) — exercise that walks this runbook
