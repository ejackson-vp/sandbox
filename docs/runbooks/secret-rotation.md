# Runbook — rotating capability, admin and mTLS secrets

Use for a scheduled rotation or an incident rotation. None of these steps require
draining sessions: each secret has an overlap window where the old and new values
are both accepted, and each window is bounded by the longest time a credential
issued under the old value can still be live.

## The four credentials

| Credential | Signs | Accepted set | Rotation needs |
| --- | --- | --- | --- |
| `CAPABILITY_SECRET` | session capabilities | current + previous key, by key id | API restart, 8 h 15 m overlap |
| `ADMIN_TOKEN` | API → controller requests | current + previous | controller restart, minutes |
| `RELAY_ADMIN_TOKEN` | controller → relay, local dev only | one value | relay + controller restart |
| mTLS keys (`CONTROLLER_TLS_*`, `RELAY_TLS_*`, `RELAY_CLIENT_TLS_*`) | transport auth | the CA's trust bundle | CA rollover, see below |

The capability and admin token are the two that a rotation used to break. The
others are restart-scoped and have no live credential to preserve.

## Capability secret

A capability is `HMAC-SHA256(key, "x402-capability:v2:<paymentKey>:<commitment>")`,
prefixed with the id of the key that signed it (`k1.<mac>`). The derivation is
unchanged from F-08 on purpose: a rotation must not change what an existing key
produces. Tokens minted before the key id existed have no prefix and stay valid
while their session lives.

The longest a capability can live is
`MAX_SESSION_LIFETIME_SECONDS + CAPABILITY_GRACE_SECONDS`, which is **8 h 15 m**
with the defaults (8 h suspend/resume ceiling, 15 min grace). Retire the old key
after a window at least that long has passed since the last capability was minted
with it.

### 1. Add the new key alongside the old one

The API reads four variables. Only `CAPABILITY_SECRET` is required; the other
three are `optional: true` in `deploy/kubernetes/10-api.yaml`, so a deployment
that is not rotating them behaves exactly as before.

```bash
NEW=$(openssl rand -base64 48)
OLD=$(kubectl -n sandbox-system get secret x402-secrets \
  -o jsonpath='{.data.capability-secret}' | base64 -d)

kubectl -n sandbox-system patch secret x402-secrets --type merge -p "$(jq -nc \
  --arg next "$NEW" --arg prev "$OLD" \
  '{data: {
      "capability-secret": ($next|@base64),
      "capability-key-id": ("k2"|@base64),
      "capability-secret-previous": ($prev|@base64),
      "capability-previous-key-id": ("k1"|@base64)
   }}')"
```

The Secret holds `k1` in the previous slot and `k2` as the signing key. A key id
that is already in use is a startup error, and so is reusing one secret in both
slots, so a mistake here fails the rollout rather than silently signing with the
wrong key.

### 2. Roll the API

```bash
kubectl -n sandbox-system rollout restart deploy/api
kubectl -n sandbox-system rollout status deploy/api
```

Expected: pods become ready; no session is interrupted, because the capability
the client holds is only compared by hash and `k1` is still in the verify set.

Nothing in the log or the metrics names a secret, so the overlap is checked with
two capabilities rather than by reading configuration. A capability issued by the
new pod starts with `k2.`; one issued before the roll starts with `k1.`. Both
work:

```bash
curl -s -H "x-sandbox-capability: k1.<mac from before the roll>" \
  https://api.example/v1/sessions/sbx_3f9c1a77e204 | jq .state
```

### 3. Wait out the overlap

At least 8 h 15 m after the last `k1` capability was minted. During this window a
create request that replays an old payment returns the original `k1` capability
(re-derived from the stored hash), not a fresh `k2` one.

### 4. Retire the old key

```bash
kubectl -n sandbox-system patch secret x402-secrets --type json -p '[
  {"op":"remove","path":"/data/capability-secret-previous"},
  {"op":"remove","path":"/data/capability-previous-key-id"}
]'
kubectl -n sandbox-system rollout restart deploy/api
kubectl -n sandbox-system rollout status deploy/api
```

Retirement is immediate and does not wait for expiry: a token whose key id is no
longer in the ring is refused before the hash comparison. A `k1` capability
presented after this step gets `404 session_not_found`, the same answer as an
invalid one, so it gives nothing away. A create replay for such a session gets
`409 capability_key_retired`, which means the overlap was cut short and the
session must be recreated.

## Admin token

The controller accepts `ADMIN_TOKEN` and, while `ADMIN_TOKEN_PREVIOUS` is set,
the previous value on `/internal/*`. The API is the only presenter.

1. Put the new token in `admin-token` and keep the old one in
   `admin-token-previous`:

   ```bash
   NEW=$(openssl rand -base64 48)
   OLD=$(kubectl -n sandbox-system get secret x402-secrets \
     -o jsonpath='{.data.admin-token}' | base64 -d)
   kubectl -n sandbox-system patch secret x402-secrets --type merge -p "$(jq -nc \
     --arg next "$NEW" --arg prev "$OLD" \
     '{data: {"admin-token": ($next|@base64), "admin-token-previous": ($prev|@base64)}}')"
   ```

2. Roll the controller first, so both values are accepted, then the API, so it
   presents the new one:

   ```bash
   kubectl -n sandbox-system rollout restart deploy/controller
   kubectl -n sandbox-system rollout status deploy/controller
   kubectl -n sandbox-system rollout restart deploy/api
   kubectl -n sandbox-system rollout status deploy/api
   ```

3. Confirm the API is accepted: `kubectl -n sandbox-system logs deploy/controller
   --since=5m | jq -r 'select(.msg=="control_api_error")'` is empty, and
   `sandbox_auth_failures_total{reason="internal_token"}` is flat.

4. Remove `admin-token-previous` and roll the controller again. The old value is
   then a `401`.

`ADMIN_TOKEN_PREVIOUS` must differ from `ADMIN_TOKEN`, from `RELAY_ADMIN_TOKEN`,
`WAKE_TOKEN` and `PROXY_TOKEN_SECRET`, and be at least 16 characters; the
controller refuses to start otherwise.

## Relay and mTLS keys

These have no live capability to preserve, but they do have a window where two
components disagree.

- `RELAY_ADMIN_TOKEN`: change the Secret, then roll the relay and the controller
  together. It is only accepted on the plaintext control routes, which a cluster
  relay does not expose.
- `RELAY_CLIENT_TLS_*` (controller's client certificate): issue a new certificate
  from the same CA, update the controller Secret, roll the controller, then revoke
  the old certificate at the CA. Because the relay trusts the CA and not the leaf,
  the old certificate keeps working until it expires unless you rebuild the CA.
- `RELAY_TLS_*` (relay's server certificate): issue, update the Secret, roll the
  relay. The controller trusts `RELAY_CLIENT_TLS_CA_FILE`, so a server certificate
  signed by the same CA needs no controller change. A new CA needs both sides.
- `CONTROLLER_TLS_*` (API's client certificate to the controller): same shape.
  The controller's `TLS_CA_FILE` is the trust anchor; rolling the CA means
  updating it on the controller first, then the API.

Certificate private keys and the CA live in the private infrastructure
repository. `scripts/dev-secrets.sh` generates throwaway material for a local
cluster; it is git-ignored and must never be committed.

## Verify

| Check | Expected |
| --- | --- |
| `kubectl -n sandbox-system get secret x402-secrets -o json \| jq '.data \| keys'` | current keys only; no `*-previous` after retirement |
| API log: `curl /readyz` | `{"ok":true}` after each roll |
| Capability from before the roll still works during overlap | `200` with `state` |
| Same capability after retirement | `404 session_not_found` |
| `sandbox_auth_failures_total{reason=~"capability_invalid|internal_token"}` | flat during the roll |
| `sandbox_sessions_failed_total` | no step increase attributable to the roll |

## Preserve evidence

For an incident rotation, record the key ids and the times, never the secrets.

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "incident-$STAMP"
kubectl -n sandbox-system get secret x402-secrets -o json \
  | jq '{name: .metadata.name, keys: (.data|keys), resourceVersion: .metadata.resourceVersion}' \
  > "incident-$STAMP/secret-shape.json"
kubectl -n sandbox-system rollout history deploy/api > "incident-$STAMP/api-history.txt"
kubectl -n sandbox-system rollout history deploy/controller > "incident-$STAMP/controller-history.txt"
```

## What is not protected

- The bootstrap Secret is a Kubernetes Secret: anyone who can read it in the
  cluster can mint capabilities for any session. There is no KMS/HSM, no
  envelope encryption at rest beyond the cluster's own, and no split-knowledge
  custody ([RELEASE_GATE](../../security-review/RELEASE_GATE.md) §4).
- There is no scheduled rotation and no expiry tracking. A rotation is a manual
  change with a calendar reminder.
- Capabilities remain bearer tokens for their TTL (F-07).

## Related

- [security-guarantees.md](../security-guarantees.md) — what the capability does and does not prove
- [relay-compromise.md](relay-compromise.md) — when you are rotating because of an incident
- [tabletop.md](tabletop.md) — exercise that walks this runbook
