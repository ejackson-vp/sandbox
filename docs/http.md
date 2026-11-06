# Local services and HTTP data plane

Status: implemented in dev/local and on the kind cluster. Request/response and
SSE/chunked streaming are supported; WebSocket streaming is the next step.

## Why

A sandbox that can only run one-shot commands cannot host a notebook, a preview
server, or an agent tool that exposes HTTP. Lambda MicroVMs solve this with a
per-VM HTTPS endpoint. x402 solves it without opening inbound pod networking:

```
client ──sealed HTTP request──► relay ──► guest ──loopback──► 127.0.0.1:<port>
client ◄──sealed HTTP response── relay ◄── guest ◄─────────── local service
```

The API/controller/relay only see an opaque envelope. The sandbox still has no
inbound route, no usable DNS, and no direct internet; the service is reachable
only through the relay and only on a port the customer declared.

## Contract

| Operation | Envelope `op` | Purpose |
|---|---|---|
| `POST /v1/sessions/{id}/services` | `service.start` | Start a long-running process (`name`, `command`, `port`) |
| `POST /v1/sessions/{id}/services/list` | `service.list` | List services and state |
| `POST /v1/sessions/{id}/services/stop` | `service.stop` | Stop and reap a service |
| `POST /v1/sessions/{id}/http` | `http.request` | HTTP request to a running service's loopback port |
| `POST /v1/sessions/{id}/http/stream` | `http.stream.open` | Open a streaming response |
| `POST /v1/sessions/{id}/http/stream/read` | `http.stream.read` | Read the next chunk (or `pending`) |
| `POST /v1/sessions/{id}/http/stream/close` | `http.stream.close` | Close and reap the stream |

All four take the same body as `/exec`:

```json
{ "requestId": "…", "envelope": "<base64 sealed box>", "timeoutMs": 30000, "waitMs": 40000 }
```

The `service.start` payload:

```json
{
  "op": "service.start",
  "name": "web",
  "command": ["python3", "-m", "http.server", "8080", "--bind", "127.0.0.1"],
  "port": 8080
}
```

The HTTP payload:

```json
{
  "op": "http.request",
  "port": 8080,
  "method": "POST",
  "path": "/api/run",
  "headers": { "content-type": "application/json" },
  "bodyBase64": "…"
}
```

The response carries `status`, `headers` and `bodyBase64`; it is sealed to the
client like every other result.

## Streaming (SSE / chunked)

`http.stream.open` starts the request and returns `streamId`, `status` and
response headers. The guest then reads the response body in a background
goroutine and buffers 64 KiB chunks. `http.stream.read` drains one chunk or
returns `pending`; the SDK polls every 100 ms. `http.stream.close` cancels the
request and frees the stream. This keeps the session's one-operation gate free:
a read is a short sealed operation, not a long-held connection.

```ts
const stream = await client.openHttpStream(handle, { port: 8080, path: "/events" });
for (;;) {
  const { chunk, done } = await stream.read();
  if (chunk) process.stdout.write(chunk);
  if (done) break;
}
await stream.close();
```

```bash
sandbox http <id> 8080 /events --stream
```

`make demo-sse` runs a Python SSE server in the sandbox and prints the ticks as
they arrive.

Streaming limits: max 4 streams, 64 MiB total per stream, 64 KiB chunks, 60 s
idle timeout, one operation at a time. WebSocket (bidirectional) needs a relay
data-channel design and is not implemented yet.

## Limits

- Max **4** services per session.
- Port must be **1024–65535** and declared by a running service.
- HTTP methods: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS; redirects are not
  followed; request body ≤ 8 MiB; response body ≤ 4 MiB (truncated flag).
- HTTP timeout 30 s (or the request's smaller `timeoutMs`).
- Streaming: max 4 streams, 64 MiB per stream, 64 KiB chunks, 60 s idle.
- One operation at a time per session, including HTTP and stream reads. The
  stream itself is read by a guest goroutine, so a read does not hold the
  connection open.
- Services are **processes**, not state that survives suspend: they are stopped
  on suspend, terminate, and lease end. Restart them after resume (a `/resume`
  hook is future work).

## Security properties

- **No host field.** The guest ignores the HTTP host and dials
  `127.0.0.1:<port>`; the port must belong to a running service. This makes
  metadata/SSRF attempts against the node or cloud metadata impossible.
- **No proxy.** The HTTP client has `Proxy: nil`; it cannot be redirected to the
  egress proxy or an external host.
- **No inbound.** The pod still has no ingress rule; the relay is the only path.
- **Same process controls.** The service runs in its own process group, under
  the same cgroup/pid/disk limits; `stop`/terminate kills the group. On Linux,
  `Pdeathsig` kills it if the supervisor dies.
- **Plaintext stays in the guest.** The command, port, headers and body travel
  inside the sealed envelope; the API/controller never see them.

## SDK and CLI

```ts
const info = await client.startService(handle, {
  name: "web",
  command: ["python3", "-m", "http.server", "8080", "--bind", "127.0.0.1"],
  port: 8080,
});
const res = await client.http(handle, { port: 8080, path: "/", method: "GET" });
console.log(res.status, res.body.toString());
await client.stopService(handle, "web");
```

```bash
sandbox serve <id> --name web --port 8080 -- python3 -m http.server 8080 --bind 127.0.0.1
sandbox services <id>
sandbox http <id> 8080 /
sandbox stop-service <id> web
```

`make demo-http` exercises the whole path on kind: start a Python server, fetch
it through the relay, list it, stop it, destroy the session.

## Comparison

| | x402 local services | Lambda MicroVMs |
|---|---|---|
| Ingress | relay-mediated, no pod ingress | per-VM HTTPS endpoint |
| Auth | session capability | JWE token |
| Protocols | HTTP request/response + SSE/chunked; WebSocket later | HTTP/2, gRPC, WebSockets |
| Host control | loopback only, declared port | app endpoint on a port |
| State on suspend | services stop | memory/process state restored |

The product shape is the same — a per-session HTTP surface — but x402 keeps the
no-inbound model and the end-to-end envelope. Streaming and WebSocket support
require a relay data-channel design and are the next step.
