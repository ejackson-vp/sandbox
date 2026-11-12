# API reference

Base URL (local): `http://localhost:8080`

There are no accounts, cookies or API keys. A paid session is accessed with a
short-lived **capability** token that the buyer receives once.

```text
X-Sandbox-Capability: <capability>
```

The server stores only `SHA-256(capability)`; the capability is scoped to one
session id and expires `lease + 900s` (configurable grace, `CAPABILITY_GRACE_SECONDS`).

## Payment protocol

`POST /v1/sessions` is x402 v2 protected.

1. Unpaid request → `402` with a base64 `PAYMENT-REQUIRED` header containing the
   price for the requested tier and a single-use `challengeNonce` (`cn_…`) in
   `accepts[0].extra`, echoed at the top level of the JSON body.
2. Client signs the requirement, then signs the **client commitment** with the
   paying wallet over `(paymentKey, clientPublicKey, clientNonce,
   challengeNonce)`. The retry carries `PAYMENT-SIGNATURE`, `challengeNonce` and
   `clientSignature`.
3. The API verifies the commitment, burns the nonce (one payment only, TTL
   `CHALLENGE_NONCE_TTL_MS`, default 180 s), verifies and settles, then creates
   **one** session.

The nonce is what stops a captured *complete* create request from being a
permanent replay: the signature covers a value the server issued and will accept
once. A reused, expired or unknown nonce is answered with `402` and a fresh
challenge, so a client retries with the **same payment payload** and a new
signature. Because the payment key does not change, that retry recovers the
existing entitlement rather than paying twice. There is no cached-challenge fast
path: each create takes the 402 round trip.

**Version note (client commitment v2).** The commitment is domain
`x402-sandbox/client-commitment/v2` and `challengeNonce` is required on any paid
create. A v1 client, which sends no `challengeNonce` and signs the old message,
gets a `402` with a fresh challenge instead of a capability: the check fails
closed and never returns an entitlement for an unproven freshness value. There is
no compatibility mode. `@x402s/sdk` 0.3.0 is the first SDK release that speaks
v2.

The price is bound to the requested tier/limits (`amount` differs per tier), and
the payment is bound to a `specHash` recorded in a durable intent. A retried
request with the same payment returns the **same session** and the same capability
(HTTP 200) instead of charging again.

## Create a session

```http
POST /v1/sessions
Content-Type: application/json
PAYMENT-SIGNATURE: <base64 x402 payload>   # omitted on the first attempt

{
  "tier": "standard",                       // short | standard | extended | long | custom
  "runtime": "base",                        // base | python | node; defaults to base
  "durationSeconds": 300,                   // required only for custom tiers
  "clientPublicKey": "<base64 X25519 pub>", // 32 bytes
  "clientNonce": "<base64 32 bytes>",       // freshness nonce bound into attestation
  "challengeNonce": "cn_…",                 // from the 402; required with a payment
  "clientSignature": "0x…",                 // payer wallet over the commitment
  "cpuMillis": 1000,                        // custom only
  "memoryMiB": 1024,                        // custom only
  "diskMiB": 1024,                          // custom only
  // optional checkpoint/resume opt-in:
  "idlePolicy": { "maxIdleSeconds": 300, "suspendedDurationSeconds": 28800, "autoResume": false },
  "maxLifetimeSeconds": 28800,              // wall clock, includes suspended time
  "baselineCpuMillis": 250,                 // optional scheduler reservation
  "baselineMemoryMiB": 256                  // default: peak/4
}
```

`201 Created` (or `200 OK` for an idempotent replay):

```jsonc
{
  "sessionId": "sbx_61744770c4f79e88223b9f9d",
  "capability": "…43-char base64url…",
  "state": "PAID",
  "tier": "standard",
  "durationSeconds": 300,
  "runtime": "base",
  "limits": {
    "cpuMillis": 1000, "memoryMiB": 1024, "diskMiB": 1024,
    "maxOutputBytes": 262144, "maxFileBytes": 8388608,
    "maxCommandSeconds": 300, "maxProcesses": 256
  },
  "capabilityExpiresAt": "2026-11-06T01:33:56.000Z",
  "clientNonce": "…",
  "payment": {
    "mode": "mock", "network": "mock:local", "scheme": "exact",
    "asset": "mock:usdc", "amount": "50000", "priceUsd": "$0.05",
    "payTo": "0x…", "payer": "0x…", "transaction": "mock:…"
  },
  "session": {                       // optional, additive: same shape as GET /v1/sessions/{id}
    "sessionId": "sbx_61744770c4f79e88223b9f9d",
    "state": "PAID",
    "tier": "standard",
    "durationSeconds": 300,
    "runtime": "base",
    "limits": { "...": 0 },
    "createdAt": "2026-11-06T01:33:56.000Z",
    "remainingSeconds": 0,           // PAID has no lease yet
    "clientNonce": "…",
    "busy": false,
    "payment": { "...": "…" }
  }
}
```

`session` is the controller's view at completion time, in the same shape as the
status endpoint, and it never contains capability material. Newer SDKs build the
local handle from it and do not need a status request after create. It is
additive: older clients ignore it, and `GET /v1/sessions/{id}` remains the
refresh path. A create against an older API omits the field, so clients must
still tolerate its absence.

Errors: `400` invalid spec/tier mismatch, `402` payment required/rejected,
`409` `payment_in_progress` or `spec_mismatch`, `429` rate limited (see
below), `503` provisioning unavailable (no payment was taken). An unknown
`runtime` is a `400 unsupported_runtime` before any capacity check or payment.

A `429` is returned before the payment is claimed or settled, so a throttled
payer is not charged. The body carries `{"error":"rate_limited","scope":"payer"|"ip"}`
and a `Retry-After` header. `CREATE_RATE_*` is per payer; `CREATE_IP_RATE_*` is
the coarse per-IP guard. See [admission-control.md](admission-control.md).

## Session status

```http
GET /v1/sessions/{id}
```

```json
{
  "sessionId": "sbx_…",
  "state": "ACTIVE",
  "tier": "standard",
  "durationSeconds": 300,
  "limits": { "...": 0 },
  "createdAt": "…", "paidAt": "…", "readyAt": "…",
  "leaseExpiresAt": "…",          // readyAt + duration; null while suspended
  "remainingSeconds": 287,        // 0 while suspended
  "suspendedAt": "…",             // present after suspend
  "resumeCount": 1,               // present after resume
  "maxLifetimeSeconds": 28800,
  "idlePolicy": { "maxIdleSeconds": 300, "suspendedDurationSeconds": 28800, "autoResume": false },
  "baseline": { "cpuMillis": 250, "memoryMiB": 256 }, // limits are the burst ceiling,
  "clientNonce": "…",
  "guestPublicKey": "<base64>",   // present once READY
  "attestation": { "...": "…" },  // signed evidence (simulated in dev)
  "busy": false,
  "payment": { "...": "…" }
}
```

`remainingSeconds` is `0` after expiry. `failure` is present for failed sessions.
`GET` is cheap; poll it while `PAID`/`PROVISIONING`.

## Execute a command

```http
POST /v1/sessions/{id}/operations
Content-Type: application/json
X-Sandbox-Capability: …

{
  "requestId": "8f7c…",      // 8–128 chars, idempotency key
  "envelope": "<base64 sealed box>",
  "timeoutMs": 30000,        // optional, hints the server's wait
  "waitMs": 40000            // optional, how long the API should wait
}
```

`200 OK`:

```json
{ "state": "ACTIVE", "requestId": "8f7c…", "envelope": "<base64 sealed box>" }
```

`202 Accepted` — the operation is still running (`pending: true`); fetch it with
`GET /v1/sessions/{id}/requests/{requestId}`.

`409 busy` — another operation is in flight (one active foreground operation per
sandbox; the SDK can queue). `409 session_not_usable`, `409
idempotency_key_reused` (the `requestId` was already used with a different
envelope, so it is neither replayed nor executed), `410 lease_expired`.

### Envelope contents (client-side)

The API never sees these fields. The SDK builds and seals them:

```jsonc
{
  "v": 2,
  "sessionId": "sbx_…",
  "clientNonce": "…",
  "requestId": "8f7c…",
  "op": "exec",
  "command": ["bash", "-c", "echo hello > /workspace/hello.txt"],
  "env": { "GREETING": "hi" },     // optional
  "cwd": "/workspace/sub",         // optional, confined to the workspace
  "stdin": "…",                    // optional
  "timeoutMs": 30000               // clamped to the lease and platform cap
}
```

Result (sealed back to the client key):

```jsonc
{
  "v": 2, "requestId": "8f7c…", "op": "exec", "ok": true,
  "exitCode": 0, "stdout": "…", "stderr": "…",
  "timedOut": false, "cancelled": false, "durationMs": 42,
  "truncated": { "stdout": false, "stderr": false }
}
```

Application errors (`ok: false`) carry `{ "error": { "code", "message" } }`, e.g.
`path_outside_workspace`, `quota_exceeded`, `file_too_large`, `unsafe_archive`,
`not_found`, `invalid_cwd`, `spawn_failed`.

## Files

All file requests are encrypted envelopes; the API only forwards them.

```http
POST /v1/sessions/{id}/operations
{ "requestId": "…", "envelope": "…" }          # op: file.put
```

```jsonc
{
  "op": "file.put", "path": "/workspace/app.py",
  "dataBase64": "…",            // file bytes, or a gzipped tar when archive=true
  "archive": false,
  "mode": 420                   // optional octal (0644)
}
```

```http
GET /v1/sessions/{id}/operations?request=<url-encoded envelope>&requestId=<id>
```

The envelope contains one of:

```jsonc
{ "op": "file.get",  "path": "/workspace/out.txt", "archive": false }
{ "op": "file.list", "path": "/workspace", "recursive": true }
{ "op": "file.stat", "path": "/workspace/out.txt" }
```

Results: `file.get` returns `{ dataBase64, size, archive }`; `file.list` returns
`{ entries: [{ path, size, mode, isDir, mtimeMs }], totalBytes }`; `file.stat`
returns `{ entry }`.

Limits: `maxFileBytes` (8 MiB default) per file/archive, `diskMiB` workspace
quota, 5000 entries per listing. Paths are confined to the workspace; absolute
paths must start with the workspace directory (`/workspace`).

## Services, HTTP and WebSockets

Services, HTTP and WebSocket operations use the same `POST /operations` route;
the operation type and its arguments are inside the sealed envelope. The API
never learns the service command, port, headers or body. HTTP is loopback-only to
a port declared by a running service; there is no inbound pod networking. See
[http.md](http.md).

Envelope `op` values in this group: `service.start`, `service.list`,
`service.stop`, `http.request`, `http.stream.open`, `http.stream.read`,
`http.stream.close`, `ws.open`, `ws.read`, `ws.send`, `ws.close`.

Common errors: `service_not_found`, `service_exists`, `port_in_use`,
`service_not_listening`, `too_many_services`, `service_unavailable`,
`invalid_port`, `invalid_method`, `http_error`, `too_many_streams`,
`stream_not_found`, `stream_idle`, `stream_error`, `stream_too_large`,
`ws_not_found`, `ws_idle`, `ws_error`, `too_many_ws`, `ws_too_large`,
`message_too_large`, `ws_write_failed`.

## Requests (reconnect / cancel)

```http
GET    /v1/sessions/{id}/requests/{requestId}?waitMs=20000
DELETE /v1/sessions/{id}/requests/{requestId}      # cancel the in-flight command
```

`GET` returns the sealed result when available, `202` while pending, `409
outcome_unknown` when the controller restarted with this request in flight and
the guest has not produced a result, and `410 result_expired` once a known
result has aged out of the relay cache (5 minutes). `outcome_unknown` is
terminal and distinct from an id the controller never saw (`404
request_not_found`): the command may still have run. Retrying an `exec` with the
same `requestId` returns the same result without executing twice. While the old
request is fenced, a new operation returns `409 busy` with the old `requestId`;
it is not forwarded to the guest.

## Suspend and resume

```http
POST /v1/sessions/{id}/suspend
X-Sandbox-Capability: …
→ 200 { "state": "SUSPENDED", ... }

POST /v1/sessions/{id}/resume
X-Sandbox-Capability: …
→ 202 { "state": "RESUMING", ... }     // poll until READY
```

Suspend stops compute and keeps the per-session workspace PVC; resume boots a
fresh guest against the same workspace with a new guest keypair. Clients must
call `resume()` (SDK) and wait for READY before sending operations. Operations
against a suspended session return `409 session_suspended`. See
[lifecycle.md](lifecycle.md).

## Images

```http
GET /v1/images
```

Returns the operator-pinned guest image, digest, runtime class and execution
mode. The digest is informational today; production admission should enforce it.

## Destroy

```http
DELETE /v1/sessions/{id}
```

Marks the session `TERMINATING`; the controller asks the guest to stop, deletes
the pod, purges relay state, deletes the workspace PVC (if any) and finalises as
`DESTROYED`. Idempotent.

## Pricing

```http
GET /v1/pricing
```

Returns the tier table, custom-session bounds and the payment network.

## Health

```http
GET /healthz
```

Liveness only: the process answers. It does not check the controller, store,
relay or provisioner.

```http
GET /readyz
```

Readiness: `200` with `{ "ok": true, "components": { "controller": { "ok": true } } }`
when the controller (and therefore its store, relay and provisioner checks)
can serve creates; `503` with a bounded component map otherwise. No tokens,
session ids or exception text are returned.

## Error codes

| HTTP | code | meaning |
| --- | --- | --- |
| 400 | `invalid_request`, `tier_duration_mismatch`, `invalid_duration`, `unsupported_runtime`, `plaintext_not_accepted` | bad input |
| 401 | `capability_required` | missing capability |
| 402 | `payment_required`, `payment_invalid:*`, `payment_settlement_rejected:*`, `challenge_nonce_required`, `challenge_nonce_reused`, `challenge_nonce_expired`, `challenge_nonce_unknown` | payment problem, or a spent challenge (retry with the same payment and the fresh challenge) |
| 404 | `session_not_found` | wrong capability or unknown session |
| 409 | `payment_in_progress`, `spec_mismatch`, `busy`, `outcome_unknown`, `session_not_usable`, `session_suspended`, `resume_unavailable`, `duplicate_session` | conflict; resume first / checkpoint node unavailable / old operation fenced / this client key already paid for a session (the new payment is refunded) |
| 410 | `lease_expired`, `capability_expired`, `result_expired` | gone |
| 413 | `payload_too_large` | envelope too big |
| 429 | `rate_limited` (`scope: payer` or `ip`), `budget_exhausted` (`scope`, `remaining`, `retryAfterSeconds`) | slow down; honour `Retry-After` |
| 503 | `admission_unavailable`, `challenge_unavailable`, `capacity_unavailable` (retryable) | try again; no payment was taken |
| 503 | `control_plane_unavailable`, `provisioning_unavailable` | transient |
