# Runbook — relay compromise

Use when the relay is suspect: an unexpected registration, a guest token used
from the wrong place, the relay admin token or control credential leaked, a
`CN=controller` client certificate unaccounted for, or envelopes the client did
not ask for.

The relay is the only path between a buyer's operations and the guest. It holds
ciphertext and routing state, never plaintext, but a forged registration lets an
attacker answer a session's operations with their own envelope. The client is
supposed to catch that with the attestation check; in `ALLOW_INSECURE_DEV=true`
the attestation key is public, so the check is worthless and the relay is the
only control left.

## What holds a credential

| Credential | Who has it | What it can do |
| --- | --- | --- |
| Guest bearer token (per session) | one guest process | register and answer as that session on 8443 |
| `CN=controller` client certificate | controller only | every `/internal/*` route on 8444 |
| `RELAY_ADMIN_TOKEN` | local dev/test only | `/internal/*` on plaintext 8443 when no TLS is configured |
| `WAKE_TOKEN` | relay | `POST /internal/wake` on the controller |

A cluster relay refuses to start without `RELAY_TLS_*`, and `/internal/*` is not
mounted on the guest listener when TLS is configured
([networking.md](../networking.md)). So on a real deployment the compromise
surface is a guest token or the controller's client certificate, not the admin
token.

## Detect

| Signal | Where | Means |
| --- | --- | --- |
| `sandbox_relay_sessions` | relay metrics | registry size; compare with live sessions |
| `sandbox_auth_failures_total{reason="relay_admin_token"}` | relay metrics | someone using the admin token on the plaintext listener |
| `relay_bad_guest_token` | relay log | a guest token that does not match the registered hash |
| `relay_duplicate_guest_connection` | relay log | two guests claiming one session |
| `relay_hello_binding_mismatch` | relay log | a hello whose session/client binding does not match |
| `relay_cross_shard_rejected` | relay log | a token carrying the wrong shard |
| `sandbox_relay_pending_requests` | alert `SandboxRelayPendingRequests` | operations stuck; a symptom, not a cause |

The registry is in memory and has no list endpoint, so the count is the only
direct read:

```bash
kubectl -n sandbox-system port-forward deploy/relay 18443:8443 &
curl -s http://127.0.0.1:18443/healthz
```

Expected on a healthy single replica:

```json
{"ok":true,"generation":"0f1c…","sessions":4}
```

Compare `sessions` with the controller's live count. A registry entry with no
session row is the forged-registration signature.

```bash
kubectl -n sandbox-system port-forward deploy/controller 19100:9100 &
curl -s http://127.0.0.1:19100/metrics | grep -E 'sandbox_sessions_active|sandbox_relay_sessions'
```

Guest-side history, newest last:

```bash
kubectl -n sandbox-system logs deploy/relay --since=2h \
  | jq -r 'select(.msg|test("relay_guest|relay_hello|relay_bad|relay_duplicate|relay_cross_shard")) | [.ts, .msg, .sessionId // "-"] | @tsv'
```

## Contain

Act in this order. The first two are enough for a single suspect session; a
suspected control credential needs all four.

1. **Purge the suspect session's registry entry.** Done through the controller,
   because only it holds `CN=controller`:

   ```bash
   ADMIN=$(kubectl -n sandbox-system get secret x402-secrets \
     -o jsonpath='{.data.admin-token}' | base64 -d)
   kubectl -n sandbox-system port-forward deploy/controller 13001:3001 &
   curl -s -X DELETE -H "x-internal-token: $ADMIN" \
     http://127.0.0.1:13001/internal/sessions/sbx_3f9c1a77e204
   ```

   Expected `{"state":"READY"}`; the reconciler terminates the session, which
   purges the relay entry, deletes the Pod and marks the ledger.

2. **Confirm the entry is gone.** Terminating the session is also the only way
   to revoke its guest token: the token is stored as a hash on the session row
   and there is no rotate-in-place endpoint.

   ```bash
   curl -s -X DELETE -H "x-internal-token: $ADMIN" \
     http://127.0.0.1:13001/internal/sessions/sbx_3f9c1a77e204
   ```

   The row still exists, so the second call returns its current state rather
   than `404`; once it is terminal the destroy is a no-op. To prove the relay
   side, re-read `/healthz` and confirm `sessions` fell by one.

3. **Rotate the relay credential that was exposed.**
   - `RELAY_ADMIN_TOKEN` (dev/test only): generate a new value, update the
     Secret, restart the relay and the controller. Both read it at startup.
   - `CN=controller` client certificate: issue a new one from the internal CA,
     roll the controller's `RELAY_CLIENT_TLS_*` Secret, then revoke the old
     certificate at the CA. The relay trusts the CA, so the old certificate keeps
     working until it expires or the CA is rebuilt; if the key alone leaked and
     you cannot revoke, redeploy the relay with a new CA, which invalidates every
     certificate at once.
   - `WAKE_TOKEN`: update the Secret and restart the relay and controller.

4. **Drop the whole registry if you cannot attribute it.** Restarting the relay
   empties the in-memory registry and every in-flight operation fails closed. The
   controller re-registers sessions on its next readiness pass and the guests
   reconnect, so most sessions survive; operations in flight at the restart do
   not ([control-plane-faults.md](../control-plane-faults.md)).

   ```bash
   kubectl -n sandbox-system rollout restart deploy/relay
   kubectl -n sandbox-system rollout status deploy/relay
   ```

   Sessions that cannot re-register are failed by the ordinary provisioning
   timeout (`failureCode: provisioning_timeout`) rather than left in `PAID`;
   the ledger is unaffected.

## Recover

- **Re-registration** is automatic: the controller registers `relayTokenHash` for
  every live session and re-registers when `state.registered` is false
  (`relay_reregister_failed` if the relay refuses).
- **Sessions that die:** the payment record stays; a session that never reached
  READY is refundable under the standard policy, a READY one is not (F-10).
- **Evidence the client saw:** if a forged envelope reached a client, the client
  failed the attestation check and has an error; ask for it. The envelope itself
  is ciphertext the attacker could not open.

## Verify

1. Registry size equals live sessions, and `generation` changed if you restarted:

   ```bash
   curl -s http://127.0.0.1:18443/healthz
   ```

2. No unauthorised control attempts since the credential changed:

   ```bash
   kubectl -n sandbox-system logs deploy/relay --since=15m \
     | jq -r 'select(.msg|test("relay_bad_guest_token|relay_duplicate_guest_connection|relay_hello_binding_mismatch")) | [.ts,.msg,.sessionId] | @tsv'
   ```

   Expected: no output.

3. `sandbox_auth_failures_total{reason="relay_admin_token"}` is flat for 15
   minutes on a deployment where the admin token is not in use.

4. A new session through the normal path reaches READY, proving registration,
   claim and response still work end to end.

## Preserve evidence

The relay log is in memory on the pod's filesystem and disappears with the pod,
so capture it before any restart.

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "incident-$STAMP"
kubectl -n sandbox-system logs deploy/relay --since=24h > "incident-$STAMP/relay.log"
kubectl -n sandbox-system logs deploy/controller --since=24h > "incident-$STAMP/controller.log"
curl -s http://127.0.0.1:18443/healthz > "incident-$STAMP/relay-healthz.json"
kubectl -n sandbox-system get pod -l app=relay -o yaml > "incident-$STAMP/relay-pods.yaml"
kubectl -n sandbox-system get secret x402-secrets -o json \
  | jq 'del(.data)' > "incident-$STAMP/secret-shape.json"
```

Record the relay `generation` before and after, the sessions added or removed,
the certificate serials, and the exact time each rotation landed. Never copy the
Secret's `data`: rotate it instead.

## Known gaps

- No per-session registry listing, and no `relaySessionCount` per session id, so
  "which entry is forged" is an inference from counts, not a direct read.
- Guest tokens cannot be rotated in place; revocation means terminating the
  session.
- The relay has no audit trail of who registered what; `relay_guest_connected`
  is the only record, and it is a log line on an ephemeral pod.
- In `ALLOW_INSECURE_DEV=true` a forged guest can produce valid attestation, so
  a relay compromise is not detectable by the client.

## Related

- [networking.md](../networking.md) — the two listeners and their credentials
- [ADR 0003](../adr/0003-guest-initiated-relay.md) — why the guest dials out
- [control-plane-faults.md](../control-plane-faults.md) — relay restart outcomes
- [secret-rotation.md](secret-rotation.md) — rotating the tokens without a drain
- [tabletop.md](tabletop.md) — exercise that walks this runbook
