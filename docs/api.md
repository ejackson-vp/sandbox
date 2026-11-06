# API reference

Base URL (local): `http://localhost:8080`

There are no accounts, cookies or API keys. A paid session is accessed with a
short-lived **capability** token that the buyer receives once.

```
X-Sandbox-Capability: <capability>
```

The server stores only `SHA-256(capability)`; the capability is scoped to one
session id and expires `lease + 900s` (configurable grace, `CAPABILITY_GRACE_SECONDS`).

## Payment protocol

`POST /v1/sessions` is x402 v2 protected.

1. Unpaid request → `402` with a base64 `PAYMENT-REQUIRED` header containing the
   price for the requested tier.
2. Client signs the requirement and retries with `PAYMENT-SIGNATURE`.
3. The API verifies and settles, then creates **one** session.

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
  "durationSeconds": 300,                   // required only for custom tiers
  "clientPublicKey": "<base64 X25519 pub>", // 32 bytes
  "clientNonce": "<base64 32 bytes>",       // freshness nonce bound into attestation
  "cpuMillis": 1000,                        // custom only
  "memoryMiB": 1024,                        // custom only
  "diskMiB": 1024                           // custom only
}
```

`201 Created` (or `200 OK` for an idempotent replay):

```json
{
  "sessionId": "sbx_61744770c4f79e88223b9f9d",
  "capability": "…43-char base64url…",
  "state": "PAID",
  "tier": "standard",
  "durationSeconds": 300,
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
  }
}
```

Errors: `400` invalid spec/tier mismatch, `402` payment required/rejected,
`409` `payment_in_progress` or `spec_mismatch`, `429` rate limited (see
below), `503` provisioning unavailable (no payment was taken).

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
  "leaseExpiresAt": "…",          // immutable: readyAt + duration
  "remainingSeconds": 287,
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
POST /v1/sessions/{id}/exec
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
sandbox; the SDK can queue). `409 session_not_usable`, `410 lease_expired`.

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
PUT /v1/sessions/{id}/files
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
GET /v1/sessions/{id}/files?request=<url-encoded envelope>&requestId=<id>
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

## Requests (reconnect / cancel)

```http
GET    /v1/sessions/{id}/requests/{requestId}?waitMs=20000
DELETE /v1/sessions/{id}/requests/{requestId}      # cancel the in-flight command
```

`GET` returns the sealed result when available, `202` while pending, `410
result_expired` once the relay cache (5 minutes) has dropped it. Retrying an
`exec` with the same `requestId` returns the same result without executing twice.

## Destroy

```http
DELETE /v1/sessions/{id}
```

Marks the session `TERMINATING`; the controller asks the guest to stop, deletes
the pod, purges relay state and finalises as `DESTROYED`. Idempotent.

## Pricing

```http
GET /v1/pricing
```

Returns the tier table, custom-session bounds and the payment network.

## Health

```http
GET /healthz
```

## Error codes

| HTTP | code | meaning |
| --- | --- | --- |
| 400 | `invalid_request`, `tier_duration_mismatch`, `invalid_duration`, `plaintext_not_accepted` | bad input |
| 401 | `capability_required` | missing capability |
| 402 | `payment_required`, `payment_invalid:*`, `payment_settlement_rejected:*` | payment problem |
| 404 | `session_not_found` | wrong capability or unknown session |
| 409 | `payment_in_progress`, `spec_mismatch`, `busy`, `session_not_usable` | conflict |
| 410 | `lease_expired`, `capability_expired`, `result_expired` | gone |
| 413 | `payload_too_large` | envelope too big |
| 429 | `rate_limited` (`scope: payer` or `ip`) | slow down; honour `Retry-After` |
| 503 | `control_plane_unavailable`, `provisioning_unavailable` | transient |
