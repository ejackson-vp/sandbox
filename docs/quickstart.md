# Quickstart

This is the shortest path from zero to a paid sandbox using only the public SDK.
It assumes the local cluster is running (`make up`) and the API is at
`http://localhost:8080`.

## Install / run

```bash
npm install
npx tsx examples/sdk-quickstart/index.ts
```

## Code

```ts
import { SandboxClient } from "@x402s/sdk";

const client = new SandboxClient({
  apiUrl: "http://localhost:8080",
  paymentMode: "mock",
});

let sandbox;
try {
  sandbox = await client.create({
    durationSeconds: 60,
    cpuMillis: 1_000,
    memoryMiB: 1_024,
    diskMiB: 512,
  });

  const result = await sandbox.exec({
    command: ["bash", "-lc", "echo hello; uname -s"],
  });
  if (result.ok === false) throw new Error(result.error.message);
  process.stdout.write(result.stdout);
} finally {
  await sandbox?.destroy();
}
```

## Files

```ts
await sandbox.upload("./input.csv", "/workspace/input.csv");
await sandbox.download("/workspace/output.csv", "./output.csv");
```

Uploads are limited to the session's `maxFileBytes` (8 MiB by default). A larger
file needs chunking or an archive split; the SDK does not stream uploads yet.

## Services

`Sandbox` exposes `exec`, files and HTTP. For a long-running service, use the
handle-based service API:

```ts
await client.startService(sandbox.handle, {
  name: "web",
  command: ["node", "/workspace/app.js"],
  port: 3000,
});
const health = await client.http(sandbox.handle, { port: 3000, path: "/health" });
```

The service process does not survive suspend/resume. Files and installed
packages do; restart the service after `resume()`.

## Errors

All expected failures are `SandboxError` values with:

- `code` — stable machine code,
- `message` — human-readable explanation,
- `status` — HTTP status where applicable,
- `requestId` — controller/relay correlation when available.

Always destroy in `finally`.

## Full examples

- `examples/python-data-processing/` — 100k-row pandas job, install, verify.
- `examples/node-http-service/` — Express, HTTP, SSE, WebSocket, faults.
- `examples/browser-automation/` — Playwright probe; stock image blocks it.
