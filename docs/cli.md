# CLI and SDK

## Install / build

```bash
npm install
npm run build          # shared → sdk → api → controller → cli
node cli/dist/index.js --help
# optional: npm link -w @x402s/cli && sandbox --help
```

The CLI stores each purchased session (id, capability, client key pair) in
`~/.config/x402-sandbox/<session-id>.json` with mode `0600`. Override the
directory with `X402_SANDBOX_HOME`.

## Commands

```bash
# buy a 5-minute sandbox; prints session id, price and expiry
sandbox create --tier standard

# buy a 15-minute sandbox with custom limits
sandbox create --duration 15m --cpu 2 --memory 2Gi --disk 2Gi
# --duration 15m maps to the "extended" tier; other values use a custom spec

# run commands in the same sandbox, same filesystem
sandbox exec <id> -- python3 --version
sandbox exec <id> -- bash -c "echo hello > /workspace/hello.txt"
sandbox exec <id> -- cat /workspace/hello.txt
sandbox exec <id> --env GREETING=hi -- bash -c 'echo $GREETING'
sandbox exec <id> --timeout 5s -- bash -c 'sleep 60'     # exits 124

# files
sandbox upload   <id> ./example.py /workspace/example.py
sandbox upload   <id> ./src        /workspace/src          # directory → tar
sandbox download <id> /workspace/output.txt ./output.txt
sandbox download <id> /workspace/src ./src --extract       # archive → dir
sandbox ls       <id> /workspace --recursive
sandbox stat     <id> /workspace/output.txt

# lifecycle
sandbox status  <id>
sandbox destroy <id>
sandbox sessions                  # locally stored handles

# convenience: create + upload + run + destroy
sandbox run examples/hello.py --duration 5m
sandbox agent-demo examples/hello.py          # purchase through @x402/fetch

sandbox pricing
```

Common flags: `--api-url`, `--payment-mode mock|testnet`, `--allow-insecure-dev`,
`--require-hardware`, `--expected-measurement`, `--json`, `--quiet`.

Simulated attestation requires `--allow-insecure-dev`; the CLI refuses to run
without it (or `--require-hardware`, which this deployment cannot satisfy).

## SDK

`@x402s/sdk` exposes `SandboxClient`:

```ts
import { SandboxClient, FileSessionStore } from "@x402s/sdk";

const client = new SandboxClient({
  apiUrl: "http://localhost:8080",
  paymentMode: "mock",
  allowInsecureDev: true,             // explicit acknowledgement
  store: new FileSessionStore(),
});

const session = await client.createSession({ tier: "standard" });
await client.waitForReady(session);   // verifies attestation

const py = await client.exec(session, { command: ["python3", "--version"] });
console.log(py.ok && py.stdout);

await client.putFile(session, { path: "/workspace/app.py", data: Buffer.from("print(1)") });
const run = await client.exec(session, { command: ["python3", "/workspace/app.py"] });
console.log(run.ok && run.stdout);

const list = await client.listFiles(session, "/workspace");
const file = await client.getFile(session, "/workspace/app.py");
if (file.ok) console.log(Buffer.from(file.dataBase64, "base64").toString());

await client.destroy(session);
```

Run the bundled example:

```bash
API_URL=http://localhost:8080 npx tsx examples/sdk-session.ts
```

Key types: `SessionHandle`, `ExecResult`, `OperationError`, `FilePutResult`,
`FileGetResult`, `FileListResult`, `FileStatResult`, `SessionStatus`.

`SandboxError { code, status, requestId? }` is thrown for transport/session
problems; command failures are returned as `ok: false` results with an error code.

## Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `EVM_PRIVATE_KEY` | SDK/CLI testnet mode | funded Base Sepolia wallet |
| `X402_SANDBOX_HOME` | CLI/SDK | session credential directory |
| `API_URL` | demo scripts | API base URL |
| `KUBECTL_CONTEXT` / `KIND_CLUSTER` | demo scripts | cluster for cleanup checks |
