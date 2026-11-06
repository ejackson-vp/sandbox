# Node HTTP service

Express app with `GET /health`, `POST /transform`, SSE `/events` and WebSocket
`/ws`. Dependencies install into `/workspace/app`.

```bash
npx tsx examples/node-http-service/workload.ts
npx tsx examples/node-http-service/faults.ts   # crash, disconnect, suspend, expiry
```

Services do not survive suspend/resume; files and `node_modules` do.
