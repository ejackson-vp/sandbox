# SDK quickstart

```bash
npx tsx examples/sdk-quickstart/index.ts
```

This uses only `@x402s/sdk`:

- `client.create()` buys and waits for a ready sandbox.
- `sandbox.exec()` runs a command.
- `finally` destroys the sandbox.

For file transfer, use `sandbox.upload(local, remote)` and
`sandbox.download(remote, local)`.
