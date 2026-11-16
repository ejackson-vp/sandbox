# Hermes alert receiver

The workload half of the alerting contract: Alertmanager POSTs a notification
here, this validates and dedupes it, and then it hands a short prompt to the
Hermes agent through the gateway's own webhook route.

The interface it implements (payload shape, auth, dedupe rules, the agent's
instruction, secret rotation) is
[`../contract/alerting/README.md`](../contract/alerting/README.md). Read that
first; this file is how the receiver is built, applied and patched.

| File | What it is |
| --- | --- |
| [`server.mjs`](server.mjs) | The receiver. Node stdlib only, no dependencies, no build |
| [`deployment.yaml`](deployment.yaml) | The Deployment in namespace `hermes` |
| [`service.yaml`](service.yaml) | `hermes-alert-receiver` (in front of the receiver) and `hermes-webhook` (in front of the agent) |
| [`networkpolicy.yaml`](networkpolicy.yaml) | `monitoring` → receiver, receiver → agent webhook port |
| [`secret.example.yaml`](secret.example.yaml) | The Secret keys, documented, not applied |
| [`test/receiver.test.mjs`](test/receiver.test.mjs) | 31 tests, `node:test`, no dependencies |
| [`kustomization.yaml`](kustomization.yaml) | Renders all of the above |

## Security posture

The receiver can start an agent run, and that agent has read access to the
cluster through the kube MCP server. It is treated as an injection surface:

- **No cluster credentials.** `automountServiceAccountToken: false`, no
  ServiceAccount, no Role, no RoleBinding. The program never calls the API
  server; it POSTs to one Service in its own namespace.
- **No secrets in the image or the ConfigMap.** The program is a single file
  mounted from a ConfigMap. The base image is the upstream `node:26-alpine`,
  pinned by the same digest `Dockerfile.control` uses. Both credentials arrive as
  environment variables from the `hermes-alert-receiver` Secret.
- **Restricted pod.** `runAsNonRoot`, UID/GID 10001, `readOnlyRootFilesystem`,
  `allowPrivilegeEscalation: false`, all capabilities dropped, `RuntimeDefault`
  seccomp. A 1 MiB `emptyDir` is the only writable path.
- **Auth before body.** The bearer token is checked before a byte of the request
  body is buffered, and the comparison is constant time.
- **Bounded input.** 256 KiB body cap, 20 alerts, 400-character annotations,
  6000-character prompt. Values are flattened to one line, so a label cannot
  start a new instruction line.
- **Nothing in the response.** Errors name a field or an upstream status, never
  echo the payload or say which part of the token was wrong.

## Apply

The receiver is not part of `deploy/kubernetes` on purpose: that renders the
sandbox control plane into `sandbox-system`. Apply this directory where the
Hermes agent lives.

```bash
# 1. The Secret first. Both values are generated, never committed.
kubectl -n hermes create secret generic hermes-alert-receiver \
  --from-literal=alertmanager-token="$(openssl rand -hex 32)" \
  --from-literal=hermes-webhook-secret="$(openssl rand -hex 32)"

# 2. The workload.
kubectl kustomize deploy/monitoring/alert-receiver | kubectl apply -f -

# 3. It is healthy when the readiness probe passes and /healthz answers.
kubectl -n hermes rollout status deploy/hermes-alert-receiver
kubectl -n hermes port-forward deploy/hermes-alert-receiver 8080:8080 &
curl -sS localhost:8080/healthz   # {"status":"ok"}
```

Then apply the Hermes-side patch below. Without it the receiver runs and is
healthy, but every delivery fails with `503 delivery_unavailable`, because
nothing is listening on the agent's webhook port.

## The Hermes-side patch

This is required, and it is not something this repository can apply: the Hermes
Deployment and its `hermes-config` ConfigMap are managed by Flux from the
private deployment repository. Two changes, one optional cleanup, then a rollout.

### 1. Enable the webhook platform and add the `alerts` route

Append to the `config.yaml` key of the `hermes-config` ConfigMap. The file
currently has no `platforms:` block, so this is an addition, not a merge:

```yaml
platforms:
  webhook:
    enabled: true
    extra:
      # The port the gateway binds. Not 8765: that containerPort is declared by
      # the Deployment and nothing has ever listened on it.
      port: 8644
      routes:
        alerts:
          # Interpolated from the environment at config load, so the ConfigMap
          # never holds the value. Hermes expands ${VAR} in config.yaml.
          secret: "${HERMES_WEBHOOK_SECRET}"
          # The agent's reply goes to the Signal home channel
          # (SIGNAL_HOME_CHANNEL, already set in this cluster). A reply of
          # exactly [SILENT] is dropped before delivery, so "this is noise" is
          # a real choice rather than a message saying so.
          deliver: signal
          prompt: |
            <the prompt from contract/alerting/README.md#the-agents-instruction>
```

The prompt is reproduced verbatim in
[`../contract/alerting/README.md#the-agents-instruction`](../contract/alerting/README.md#the-agents-instruction).
Paste it as-is: it is the whole instruction, and it is the only place the three
choices (investigate, ignore, message) are defined. `{prompt}` at the end is the
only interpolated field, and it is the receiver's rendered text, not the raw
Alertmanager document.

Why a static route and not `hermes webhook subscribe`: the CLI writes
`webhook_subscriptions.json` under `/opt/data` at runtime, so the route would not
be in Git, Flux would not reconcile it, and the HMAC secret would land on the PVC
in plaintext. The static route keeps the secret in an environment variable and
the route in the ConfigMap.

### 2. Pass the shared secret to the gateway

The `hermes` container in the `hermes` Deployment needs the value that
`config.yaml` interpolates. Strategic merge patch, which merges `env` by name:

```yaml
spec:
  template:
    spec:
      containers:
        - name: hermes
          env:
            - name: HERMES_WEBHOOK_SECRET
              valueFrom:
                secretKeyRef:
                  name: hermes-alert-receiver
                  key: hermes-webhook-secret
```

```bash
kubectl -n hermes patch deploy hermes --type strategic -p "$(cat hermes-webhook-env.patch.yaml)"
```

An unset variable is not an empty secret. Hermes keeps an unresolved `${...}`
verbatim, so if this env var is missing the route starts with the *literal*
string `${HERMES_WEBHOOK_SECRET}` as its HMAC key, and anything that knows that
string could sign a request. That is why step 4 ends with a signed delivery
rather than a pod status: a 401 from Hermes is the symptom, and the fix is the
env var, not the route. Writing it as `${env:HERMES_WEBHOOK_SECRET}` behaves the
same but logs a warning when the variable is unset, which makes the mistake
visible in the gateway log.

### 3. Optional: name the port and delete the dead one

The Deployment declares `containerPort: 8765` named `gateway`, which nothing
listens on. It is harmless (a `containerPort` is documentation) but misleading,
and it is the reason a port-forward to 8765 is refused. Replacing it is a
cleanup, not a requirement, because the Service targets 8644 by number:

```yaml
spec:
  template:
    spec:
      containers:
        - name: hermes
          ports:
            - name: webhook
              containerPort: 8644
              protocol: TCP
```

### 4. Roll the pod, then verify

`config.yaml` is mounted with `subPath`, so a ConfigMap change never reaches a
running container. The rollout is part of the patch, not an afterthought:

```bash
kubectl -n hermes rollout restart deploy/hermes
kubectl -n hermes rollout status deploy/hermes

kubectl -n hermes exec deploy/hermes -c hermes -- curl -sS http://127.0.0.1:8644/health
kubectl -n hermes exec deploy/hermes -c hermes -- \
  curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8644/webhooks/alerts \
  -H 'content-type: application/json' -d '{}'
```

`/health` should answer `{"status":"ok","platform":"webhook"}` and the unsigned
POST should answer `401`. That 401 is the useful one: a route that does not exist
answers `404` before auth runs, so `401` proves the `alerts` route is loaded *and*
that a request without a signature is refused. Every `hermes` invocation also
prints `install out of sync (pnpm: not installed or outdated)`; that warning
predates this change and is not an error.

`hermes webhook list` is not a check here: it lists the dynamic subscriptions in
`webhook_subscriptions.json`, and this route is static from `config.yaml`.

End to end, from a machine that can reach the receiver:

```bash
kubectl -n hermes port-forward deploy/hermes-alert-receiver 8080:8080 &
TOKEN=$(kubectl -n hermes get secret hermes-alert-receiver -o jsonpath='{.data.alertmanager-token}' | base64 -d)
curl -sS -X POST localhost:8080/alerts \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data @deploy/monitoring/contract/alerting/example-payload.json
```

`{"status":"delivered","delivered":1,"suppressed":0}` means the agent admitted
the run. This is a real run against a real cluster: it costs a model call, and
the agent may message the operator over Signal. Send `[SILENT]`-worthy noise if
you want the quiet path tested instead.

## Failure modes to expect

| Symptom | Cause |
| --- | --- |
| `503 delivery_unavailable` on every POST | the Hermes patch is not applied, or port 8644 is not bound |
| `502 delivery_rejected`, `upstream_status: 401` | `hermes-webhook-secret` differs between the receiver and the Hermes Deployment |
| `502 delivery_rejected`, `upstream_status: 404` | the route is not named `alerts`, or the platform is not enabled |
| `502 delivery_rejected`, `upstream_status: 429` | more than 30 deliveries in a minute on one route; the Hermes webhook platform rate-limits per route |
| `401` from the receiver | the token in Alertmanager's `credentials_file` is not the one in the Secret |
| Nothing arrives at all | there is no Alertmanager in the cluster; the rules are evaluated with `-notifier.blackhole` |

## Network policies

Two policies, both in [`networkpolicy.yaml`](networkpolicy.yaml):

- the receiver accepts 8080 from the `monitoring` namespace only, and reaches
  cluster DNS plus `app: hermes` on 8644 only;
- the Hermes pod accepts 8644 from the receiver pod only.

The second policy changes the Hermes pod from default-allow to an allow-list.
That is safe for this workload because the only other listeners are loopback
(dashboard 55757, gateway API server 8642, signal-cli 8080), and
`kubectl port-forward` reaches those inside the pod's network namespace without
crossing its veth, so the policy does not see them. Re-check a port-forward after
applying it anyway; a CNI that enforces policy on host-originated traffic would
need its own allowance, and Cilium's is `fromEntities: [host]` in a
`CiliumNetworkPolicy`.

## Tests

```bash
npm run test:alert-receiver     # node --test, 31 cases, no dependencies
```

The suite runs the real server on a loopback socket and injects the outbound
`fetch`, the clock and the log sink. It covers the auth paths, every 400/413, the
signature Hermes will verify (recomputed from the captured body and timestamp),
the 300 s replay window, each dedupe transition including the flap case, prompt
flattening and truncation, and the three delivery failure modes. One case feeds
[`../contract/alerting/example-payload.json`](../contract/alerting/example-payload.json)
through the server, so the committed example cannot drift from the parser.

## Known limits

- **One replica, in-memory dedupe.** A restart re-delivers at most one
  notification per fingerprint. `Recreate` keeps a rollout from running two
  receivers at once. A second replica would double-deliver, so scaling this
  needs a shared store first.
- **No metrics endpoint.** Failures are in the pod log as one JSON line each
  (`delivery_failed` with `upstream_status`). There is no counter to alert on,
  which is a gap worth closing before this carries page-worthy traffic.
- **No retry queue.** Alertmanager retries 5xx; the receiver does not. That is
  the smaller amount of state to get wrong.
- **Alertmanager itself is not in this repository.** The reference deployment stack has none,
  so the contract is ready and nothing calls it yet.
