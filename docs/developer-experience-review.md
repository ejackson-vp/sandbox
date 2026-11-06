# Developer-experience review

## What a developer had to do

Before the facade, the shortest useful flow was:

```ts
const handle = await client.createSession({ ... });
await client.waitForReady(handle);
await client.putFile(handle, { path, data: await readFile(local) });
const result = await client.exec(handle, { command: [...] });
const file = await client.getFile(handle, remote);
await writeFile(local, Buffer.from(file.dataBase64, "base64"));
await client.destroy(handle);
```

That is understandable, but every example repeats handle management,
readiness, file encoding and cleanup.

The new facade reduces the common path to:

```ts
let sandbox;
try {
  sandbox = await client.create({ durationSeconds: 60, cpuMillis: 1000, memoryMiB: 1024, diskMiB: 512 });
  const result = await sandbox.exec({ command: ["bash", "-lc", "echo hello"] });
  if (result.ok === false) throw new Error(result.error.message);
  process.stdout.write(result.stdout);
} finally {
  await sandbox?.destroy();
}
```

`examples/sdk-quickstart/index.ts` is **32 lines**, including imports,
configuration, execution and `finally` cleanup.

## Facade surface

`SandboxClient.create()` now:

- buys the session,
- waits for READY,
- verifies attestation,
- returns a `Sandbox`.

`Sandbox` provides:

- `exec(opts)`
- `upload(localPath, remotePath)`
- `download(remotePath, localPath)`
- `http(opts)`
- `status()`, `suspend()`, `resume()`, `destroy()`
- `handle` for lower-level operations when needed

Low-level `createSession`, `putFile`, `getFile` and handle-based methods remain
available for tools that attach to an existing session.

## Improvements made from workload friction

1. **Custom resource inference.** `create({ cpuMillis, memoryMiB, diskMiB })`
   now infers `tier: "custom"` instead of failing with a standard-tier duration
   mismatch. The earlier quickstart needed tribal knowledge here.
2. **Clear file limit.** Uploading more than the session's `maxFileBytes` now
   throws `file_too_large` before encryption/transfer. Previously a 9 MiB upload
   produced a generic `invalid_request` that referenced an envelope limit.
3. **Service restart after crash.** A crashed service no longer blocks restarting
   the same name; the guest replaces a dead registry entry. It still refuses a
   live duplicate service and a live duplicate port.
4. **Path-shaped upload/download.** The facade handles local file I/O and
   base64 decoding so examples do not repeat it.
5. **Package managers present.** `pip` and `npm` are in the guest image, so
   dependency installation is possible through the existing egress proxy.

## Remaining friction

- **Uploads are capped at 8 MiB.** A larger artifact needs chunking or an
  archive split. The SDK does not stream uploads.
- **Services do not survive suspend.** Files and `node_modules` survive; the
  process does not. Customers must restart the service after resume.
- **No supervisor/restart policy.** A crash is detectable through failed health
  checks, but the platform does not automatically restart the service.
- **SSE/WebSocket are exposed lower-level.** `Sandbox` does not yet wrap
  `openHttpStream` or `openWebSocket`; the handle remains public for that.
- **No progress reporting** for uploads, installs or long commands.
- **Error classes are clear but not exhaustive.** `SandboxError.code` covers
  payment, capacity, lifecycle, file and transport failures; there is no
  structured recovery hint beyond code/status/message.
- **No automatic retry** for transient relay/connection failures. Readiness and
  reattachment exist, but retry policy belongs to the caller.

## Errors observed

| Situation | Error | Assessment |
|---|---|---|
| Duration 60 with default standard tier | `tier_duration_mismatch` | Fixed by custom inference when resource fields are supplied |
| 9 MiB upload | `invalid_request` envelope too big | Fixed with `file_too_large` client check |
| Crashed service restart | `service_exists` | Fixed; dead entry replaced |
| Capacity exhaustion | `capacity_unavailable` with `retryable` | Good |
| Service not healthy yet | HTTP connection errors until start | Caller polls; could be wrapped |
| Browser launch | Playwright executable missing | Correct runtime blocker |

## Quickstart

See [quickstart.md](quickstart.md) and `examples/sdk-quickstart/`.

The quickstart uses only `@x402s/sdk`; it does not import controller, API,
database or Kubernetes modules.
