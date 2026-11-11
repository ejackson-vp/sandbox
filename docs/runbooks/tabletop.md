# Tabletop exercise — egress abuse, orphan storage, relay compromise

A 90-minute exercise for two people (an operator and a note-taker). It walks the
three runbooks against a live cluster and records where the procedure breaks.
The output is a gap list with an owner and a date, not a pass/fail.

Run it quarterly, and once after any change to the egress proxy, the reaper or
the relay's credential handling.

## Before the day

- [ ] A kind or homelab cluster from `make up`, one node, `PAYMENT_MODE=mock`.
- [ ] Operator access to `sandbox-system` and `sandbox-workloads`, `kubectl`,
      `jq`, and a checkout at the revision under test.
- [ ] One throwaway session, kept READY, as the test subject.
      `./cli/dist/index.js create --tier short --payment-mode mock`
- [ ] The clock visible to both people. Every step gets a timestamp.
- [ ] A shared doc with three columns: **step**, **time to complete**, **what
      was wrong**.

Do not run this on a cluster with real payments.

## Ground rules

- The operator follows the runbook literally. If a command is wrong, write that
  down and keep going; do not improvise and then fix the runbook from memory.
- The note-taker records the exact command that failed and the output, not a
  summary.
- Anything that needed a step not in the runbook is a gap.
- Anything that took more than 5 minutes to find is a gap.

## Scenario A — egress abuse (25 min)

**Inject:** tell the operator that a customer reported a session hammering
`example.com` and that upstream has threatened to block the egress range.

| # | Step | Expected |
| --- | --- | --- |
| A1 | Detect: `/stats` on the proxy | `active`/`denied`/`allowed` returned; note the counts |
| A2 | Attribute: group `egress_denied` by session in the proxy log | at least one row with a session id, or an explicit "no denials" |
| A3 | Attribute: group `egress_allowed` by prefix in the proxy log | the test session's prefix is visible |
| A4 | Resolve the prefix to a session id via pod labels | the id matches the test session |
| A5 | Contain: `DELETE /internal/sessions/<id>` through the controller | `{"state":...}`, then `TERMINATING` |
| A6 | Verify: session `404`, no pod, no PVC | all three |
| A7 | Verify: no new `egress_allowed` for the prefix | no output |
| A8 | Evidence: capture the folder | session JSON, proxy log, stats present |

Ask afterwards: how long from "customer report" to "session gone"? Anything over
15 minutes is a gap in the runbook's detect step.

## Scenario B — orphan storage (25 min)

**Inject:** a Pod and a PVC for a session id that does not exist.

```bash
kubectl -n sandbox-workloads run sbx-orphan0000000000 --image=busybox \
  --labels='app.kubernetes.io/name=x402-sandbox,x402.io/pool=sandbox,x402.io/session=sbx_orphan0000000000' \
  --restart=Never -- sleep 3600
kubectl -n sandbox-workloads apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: x402-ws-orphan0000000000
  labels:
    x402.io/session: sbx_orphan0000000000
    x402.io/pool: workspace
spec:
  accessModes: [ReadWriteOnce]
  resources: {requests: {storage: 64Mi}}
EOF
```

| # | Step | Expected |
| --- | --- | --- |
| B1 | Detect: compare `pool=sandbox` Pods with `sandbox_sessions_active` | the orphan shows up as a surplus |
| B2 | Triage: `GET /internal/sessions/sbx_orphan0000000000` | `404` |
| B3 | Contain: delete Pod and PVC with `--wait=false` | both gone or terminating |
| B4 | Recover: `GET /internal/capacity` before and after | reservation counts unchanged (there was none) |
| B5 | Verify: no resources for the label | `No resources found` |
| B6 | Evidence: capture pod/pvc yaml | present |

Then the harder variant, if there is time: a **real** READY session whose Pod is
deleted by hand. The runbook must tell the operator not to clean up by hand and
to expect the reconciler to fail the session. If the runbook does not stop them,
that is a gap.

## Scenario C — relay compromise (30 min)

**Inject:** an unexpected session appears in the relay registry. Simulate it by
creating a session, noting its id, then telling the operator that this session is
"not ours".

| # | Step | Expected |
| --- | --- | --- |
| C1 | Detect: `/healthz` on the relay | `sessions` count and `generation` |
| C2 | Detect: compare with `sandbox_sessions_active` | the difference is identified |
| C3 | Detect: grep `relay_guest_connected` for the id | the connection is in the log with a timestamp |
| C4 | Contain: `DELETE /internal/sessions/<id>` | purged, session terminating |
| C5 | Contain: second `DELETE` explains the state, not `404` | clear text |
| C6 | Verify: `sessions` fell by one | yes |
| C7 | Recover: `rollout restart deploy/relay` and confirm re-registration | a live session survives, or the failure is explained |
| C8 | Evidence: relay log captured **before** the restart | present |

The trap in this scenario is C8. If the operator restarts the relay before
capturing its log, the evidence is gone. Note whether the runbook warned them
early enough.

## Scenario D — rotation under load (10 min, optional)

Start one long operation, then run `secret-rotation.md` step 1 and 2 (add the new
capability key, roll the API). The operation must not be interrupted, and the
capability issued before the roll must still return `200`.

If the cluster is not set up for a real capability rotation, skip this and note
it as untested.

## After

1. Read the three-column doc back. Every row with a gap becomes a numbered item.
2. For each item, decide: **fix the runbook** (wrong command), **fix the code**
   (a missing log field or metric), or **accept** (with the reason).
3. File the code fixes as separate issues. Do not fix them during the exercise.
4. Put the gap list in `docs/runbooks/tabletop-gaps.md` with the date, the
   revision, and an owner per item. Delete a gap when it is fixed; keep the file
   as the record of what the exercises have found.

## What this exercise does not cover

- Real money: refunds, disputes and chargebacks are out of scope; the mock ledger
  cannot exercise them.
- Kata isolation and Cilium packet paths: separate suite (`make security-test`).
- Multi-node storage failure and node loss. The checkpoint is node-pinned, and
  `resume_unavailable` is fail-fast, so there is no recovery to rehearse.
