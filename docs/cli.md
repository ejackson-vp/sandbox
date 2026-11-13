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

# steady-state reservation + burst ceiling (default baseline = peak/4)
sandbox create --duration 15m --cpu 2 --memory 2Gi --baseline-cpu 0.5 --baseline-memory 512Mi

# checkpointed session: suspend after 5 idle minutes, 8h wall clock
sandbox create --duration 15m --idle 5m --max-lifetime 8h

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
sandbox suspend <id>              # stop compute, keep the workspace PVC
sandbox resume  <id>              # new guest key, same files
sandbox destroy <id>
sandbox sessions                  # locally stored handles

# local services / HTTP through the relay
sandbox serve <id> --name web --port 8080 -- python3 -m http.server 8080 --bind 127.0.0.1
sandbox services <id>
sandbox http <id> 8080 /
sandbox http <id> 8080 /events --stream   # SSE/chunked output
sandbox stop-service <id> web

# a checkpoint is disk-only: processes, memory and sockets do not survive.
# on local-path storage it is node-pinned; resume returns resume_unavailable
# if that node is cordoned or gone.

# convenience: create + upload + run + destroy
sandbox run examples/hello.py --duration 5m
sandbox agent-demo examples/hello.py          # purchase through @x402/fetch

# one-shot run: fresh session, upload, exec, download, destroy
sandbox run -- python3 --version
sandbox run --file data.csv=data.csv --file analyze.py=analyze.py --return out.csv -- python3 analyze.py
sandbox run --runtime base --timeout 30s --return out.txt -- bash -c 'echo hi > out.txt'

# One-shot file paths are workspace-relative (/workspace is implied). --return
# writes the downloaded file to the same relative path in the current directory.
# Supported runtimes are base, python and node. An unknown name fails with
# unsupported_runtime before a session is created; the server rejects it too.

sandbox pricing
```

Common flags: `--api-url`, `--payment-mode mock|testnet`, `--json`, `--quiet`.

### Operator commands

These call the controller's internal routes with `CONTROLLER_ADMIN_TOKEN` (or
`ADMIN_TOKEN`), and `CONTROLLER_URL` (default `http://localhost:3001`). No new
credential is created for them.

```bash
sandbox admin capacity                     # reservations and capacity

sandbox admin allowlist                    # wallets that get a free session
sandbox admin allowlist add 0xabc… --label owner-agent \
  --max-tier long --max-concurrent 2       # default tier standard, 1 concurrent
sandbox admin allowlist disable 0xabc…     # immediate; re-add to re-enable
```

The allowlist is a trust boundary: a listed address gets a $0 session at or
below `--max-tier`, up to `--max-concurrent` live free sessions, with its budget
namespaced away from paying payers. The deployment must also set
`PAYER_ALLOWLIST_ENABLED=true` on the API. See
[ADR 0013](adr/0013-free-entitlement-from-proven-address.md).

There is no attestation opt-in flag: every mode is non-hardware-backed, and
`docs/security-guarantees.md` says so plainly.

## SDK

`@x402s/sdk` exposes `SandboxClient`.

**0.3.0 is a breaking release.** The client commitment moved to domain
`x402-sandbox/client-commitment/v2`, which covers the server-issued
`challengeNonce` from the 402. `challengeNonce` is required on any paid create, so
a client built against 0.2.x gets a `402` with a fresh challenge instead of a
capability. The SDK no longer caches a challenge (a single-use nonce makes a
cached one unusable), so every create takes the 402 round trip, and a rejected
challenge is retried with the same payment payload so a settled payment recovers
its entitlement instead of being charged twice.

```ts
import { SandboxClient, FileSessionStore } from "@x402s/sdk";

const client = new SandboxClient({
  apiUrl: "http://localhost:8080",
  paymentMode: "mock",
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

One-shot runs create a fresh session, upload inputs, exec, download outputs and
always destroy it:

```ts
const result = await client.run({
  runtime: "python",                     // optional: base | python | node (default base)
  command: ["bash", "-c", "python3 app.py > out.txt"],
  files: { "app.py": "print('hello')" }, // workspace-relative keys
  returnFiles: ["out.txt"],              // workspace-relative paths
  tier: "short",
});
console.log(result.sessionId, result.exitCode, result.stdout);
console.log(Buffer.from(result.files["out.txt"]).toString());
```

Unknown runtimes fail with `unsupported_runtime` before a session is created.
If cleanup fails after a run error, the run error is preserved and its
`cleanupError` property carries the destroy failure.

Run the bundled example:

```bash
API_URL=http://localhost:8080 npx tsx examples/sdk-session.ts
```

Key types: `SessionHandle`, `ExecResult`, `OperationError`, `FilePutResult`,
`FileGetResult`, `FileListResult`, `FileStatResult`, `SessionStatus`,
`RunOptions`, `RunResult`.

`SandboxError { code, status, requestId? }` is thrown for transport/session
problems; command failures are returned as `ok: false` results with an error code.

## Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `EVM_PRIVATE_KEY` | SDK/CLI testnet mode | funded Base Sepolia wallet |
| `X402_SANDBOX_HOME` | CLI/SDK | session credential directory |
| `API_URL` | demo scripts | API base URL |
| `KUBECTL_CONTEXT` / `KIND_CLUSTER` | demo scripts | cluster for cleanup checks |
