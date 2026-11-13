/**
 * Command execution and the guest data plane.
 *
 * Split out of api-flow.test.ts. Everything here answers "did the command
 * actually run, and did the bytes come back": the persistent filesystem across
 * execs, one-shot run, file transfer and archive round trips, per-command
 * timeouts, request-id idempotency, recovery after a dropped connection, and
 * the loopback HTTP, SSE and WebSocket planes through the relay. Payment cases
 * and lifecycle races are in the sibling api-* files; the stack is shared
 * through support/api-harness.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import { SandboxError } from "../../sdk/src/index.js";
import type { SandboxClient } from "../../sdk/src/index.js";
import { makeTar } from "../helpers/tar.js";
import { hostPathEnv } from "./dev-path.js";
import { freePort } from "./ports.js";
import { sleep, startHarness, type Harness } from "./support/api-harness.js";

let harness: Harness;
let client: SandboxClient;
let store: PostgresStore;
let pollStatus: Harness["pollStatus"];

beforeAll(async () => {
  harness = await startHarness({ namespace: "integration-api-execution", portOffset: 10 });
  client = harness.client;
  store = harness.store;
  pollStatus = harness.pollStatus;
});

afterAll(async () => {
  await harness.stop();
});

describe("session execution", () => {
  it("runs many commands against one persistent filesystem, then destroys", async () => {
    const handle = await client.createSession({ tier: "standard" });
    const ready = await client.waitForReady(handle);
    expect(ready.state).toBe("READY");
    expect(ready.attestation?.insecureDevOnly).toBe(true);
    expect(ready.leaseExpiresAt).toBeTruthy();
    expect(ready.remainingSeconds).toBeGreaterThan(280);

    const py = await client.exec(handle, { command: ["python3", "--version"] });
    expect(py.ok).toBe(true);
    if (py.ok) expect(py.stdout).toContain("Python");

    const mk = await client.exec(handle, { command: ["bash", "-c", "mkdir -p sub && echo hello > test.txt"] });
    expect(mk.ok).toBe(true);

    const cat = await client.exec(handle, { command: ["cat", "test.txt"] });
    expect(cat.ok).toBe(true);
    if (cat.ok) expect(cat.stdout).toBe("hello\n");

    const env = await client.exec(handle, { command: ["bash", "-c", "echo $GREETING"], env: { GREETING: "hi" } });
    if (env.ok) expect(env.stdout.trim()).toBe("hi");

    const code = await client.exec(handle, { command: ["bash", "-c", "echo err >&2; exit 9"] });
    if (code.ok) {
      expect(code.exitCode).toBe(9);
      expect(code.stderr.trim()).toBe("err");
    }

    const status = await client.status(handle);
    expect(status.state).toBe("READY");

    const destroyed = await client.destroy(handle);
    expect(destroyed?.state).toBe("DESTROYED");
    expect((await store.getSession(handle.sessionId))?.podName).toBeNull();
  }, 90_000);

  it("runs one-shot: uploads, collects returns, and destroys the session", async () => {
    const result = await client.run({
      tier: "custom",
      durationSeconds: 60,
      command: [
        "bash",
        "-c",
        "mkdir -p out && tr a-z A-Z < in.txt > out/upper.txt && echo done >&2",
      ],
      files: { "in.txt": "hello\n" },
      returnFiles: ["out/upper.txt"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("done");
    expect(Buffer.from(result.files["out/upper.txt"]!).toString()).toBe("HELLO\n");
    expect((await store.getSession(result.sessionId))?.state).toBe("DESTROYED");
  }, 90_000);

  it("uploads, lists, stats, downloads files and round-trips archives", async () => {
    const handle = await client.createSession({ tier: "custom", durationSeconds: 60 });
    await client.waitForReady(handle);

    const put = await client.putFile(handle, { path: "upload/hello.txt", data: Buffer.from("uploaded\n") });
    expect(put.ok).toBe(true);

    const list = await client.listFiles(handle, "upload");
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.entries.map((e) => e.path)).toContain("upload/hello.txt");

    const stat = await client.statFile(handle, "upload/hello.txt");
    if (stat.ok) expect(stat.entry?.size).toBe(9);

    const get = await client.getFile(handle, "upload/hello.txt");
    expect(get.ok).toBe(true);
    if (get.ok) expect(Buffer.from(get.dataBase64, "base64").toString()).toBe("uploaded\n");

    const archive = await client.putFile(handle, {
      path: "tree",
      data: makeTar([
        { name: "a.txt", content: "one" },
        { name: "nested/b.txt", content: "two" },
      ]),
      archive: true,
    });
    expect(archive.ok).toBe(true);

    const tar = await client.getFile(handle, "tree", true);
    expect(tar.ok).toBe(true);
    if (tar.ok) expect(Buffer.from(tar.dataBase64, "base64").length).toBeGreaterThan(50);

    const escaped = await client.getFile(handle, "../../etc/passwd");
    expect(escaped.ok).toBe(false);
    if (!escaped.ok) expect(escaped.error?.code).toMatch(/path_outside_workspace|symlink_escape/);

    await client.destroy(handle);
  }, 90_000);

  it("enforces per-command timeouts and rejects concurrent operations", async () => {
    const handle = await client.createSession({ tier: "custom", durationSeconds: 60 });
    await client.waitForReady(handle);

    const timeout = await client.exec(handle, {
      command: ["bash", "-c", "sleep 30 & echo $! > bg.pid; wait"],
      timeoutMs: 500,
    });
    expect(timeout.ok).toBe(true);
    if (timeout.ok) {
      expect(timeout.timedOut).toBe(true);
      expect(timeout.durationMs).toBeLessThan(5000);
    }
    const check = await client.exec(handle, {
      command: ["bash", "-c", "kill -0 $(cat bg.pid) 2>/dev/null && echo alive || echo dead"],
    });
    expect(check.ok).toBe(true);
    if (!check.ok) throw new Error(`follow-up exec failed: ${check.error?.code ?? "unknown"}`);
    expect(check.stdout.trim()).toBe("dead");

    const long = client.exec(handle, { command: ["sleep", "5"] });
    await sleep(500);
    await expect(client.exec(handle, { command: ["echo", "nope"] })).rejects.toMatchObject({ code: "session_busy" });
    const finished = await long;
    expect(finished.ok).toBe(true);

    await client.destroy(handle);
  }, 90_000);

  it("does not execute twice when a request is retried with the same id", async () => {
    const handle = await client.createSession({ tier: "custom", durationSeconds: 60 });
    await client.waitForReady(handle);

    const requestId = "retry-test-request-0001";
    const first = await client.exec(handle, {
      command: ["bash", "-c", "echo x >> counter.txt; wc -l < counter.txt"],
      requestId,
    });
    const second = await client.exec(handle, {
      command: ["bash", "-c", "echo x >> counter.txt; wc -l < counter.txt"],
      requestId,
    });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.stdout.trim()).toBe("1");
      expect(second.stdout.trim()).toBe("1");
    }
    await client.destroy(handle);
  }, 90_000);

  it("survives a client disconnect and returns the result by request id", async () => {
    const handle = await client.createSession({ tier: "custom", durationSeconds: 60 });
    await client.waitForReady(handle);

    const requestId = "disconnect-request-0001";
    const controller = new AbortController();
    const pending = client
      .exec(handle, {
        command: ["bash", "-c", "sleep 2; echo finished-after-disconnect"],
        requestId,
        signal: controller.signal,
      })
      .catch((err: unknown) => err);
    setTimeout(() => controller.abort(), 400);
    const aborted = await pending;
    expect(aborted).toBeInstanceOf(Error);

    const result = await client.getOperation(handle, requestId, 30_000);
    expect(result).toBeTruthy();
    expect(result?.ok).toBe(true);
    if (result?.ok && result.op === "exec") {
      expect(result.stdout).toContain("finished-after-disconnect");
    }
    await client.destroy(handle);
  }, 90_000);

  it("expires short leases and refuses work afterwards", async () => {
    const handle = await client.createSession({ tier: "custom", durationSeconds: 3 });
    const ready = await client.waitForReady(handle);
    expect(ready.remainingSeconds).toBeLessThanOrEqual(3);

    await sleep(5000);
    const final = await pollStatus(handle, (s) => ["EXPIRED", "TERMINATING", "DESTROYED"].includes(s.state), 20_000);
    expect(["EXPIRED", "TERMINATING", "DESTROYED"]).toContain(final.state);

    const late = await client.exec(handle, { command: ["echo", "late"] }).catch((err: unknown) => err);
    expect(late).toBeInstanceOf(SandboxError);
    expect(["lease_expired", "session_not_usable", "guest_not_available", "session_busy", "control_plane_unavailable"]).toContain(
      (late as SandboxError).code,
    );
  }, 60_000);
});

describe("local services and HTTP data plane", () => {
  it("starts a loopback server and fetches it through the relay", async () => {
    const handle = await client.createSession({ tier: "custom", durationSeconds: 60 });
    await client.waitForReady(handle);
    await client.putFile(handle, { path: "index.html", data: Buffer.from("hello-http\n") });

    const port = await freePort();
    const info = await client.startService(handle, {
      name: "web",
      command: ["python3", "-m", "http.server", String(port), "--bind", "127.0.0.1"],
      port,
    });
    expect(info.state).toBe("running");
    expect(info.port).toBe(port);

    const services = await client.listServices(handle);
    expect(services.map((s) => s.name)).toContain("web");

    const response = await client.http(handle, { port, path: "/", method: "GET" });
    expect(response.status).toBe(200);
    expect(response.body.toString()).toContain("hello-http");

    // A port that is not declared by a running service is rejected.
    await expect(client.http(handle, { port: port === 65535 ? port - 1 : port + 1, path: "/" })).rejects.toMatchObject({
      code: "service_unavailable",
    });

    await client.stopService(handle, "web");
    await expect(client.http(handle, { port, path: "/" })).rejects.toMatchObject({
      code: "service_unavailable",
    });
    await client.destroy(handle);
  }, 180_000);
});

describe("streaming HTTP data plane", () => {
  it("streams SSE chunks through the relay", async () => {
    const handle = await client.createSession({ tier: "custom", durationSeconds: 60 });
    await client.waitForReady(handle);
    await client.putFile(handle, {
      path: "sse.py",
      data: Buffer.from(
        [
          "from http.server import BaseHTTPRequestHandler, HTTPServer",
          "import time",
          "class H(BaseHTTPRequestHandler):",
          "    def do_GET(self):",
          "        self.send_response(200)",
          "        self.send_header('Content-Type', 'text/event-stream')",
          "        self.end_headers()",
          "        for i in range(5):",
          "            self.wfile.write(f'data: tick {i}\\n\\n'.encode())",
          "            self.wfile.flush()",
          "            time.sleep(0.2)",
          "HTTPServer(('127.0.0.1', 18082), H).serve_forever()",
        ].join("\n"),
      ),
    });
    await client.startService(handle, {
      name: "sse",
      command: ["python3", "sse.py"],
      port: 18082,
    });
    const stream = await client.openHttpStream(handle, { port: 18082, path: "/events" });
    let text = "";
    let done = false;
    for (let i = 0; i < 100 && !done; i++) {
      const part = await stream.read();
      if (part.chunk) text += part.chunk.toString();
      done = part.done;
    }
    expect(text).toContain("tick 0");
    expect(text).toContain("tick 4");
    await stream.close();
    await client.stopService(handle, "sse");
    await client.destroy(handle);
  }, 180_000);
});

describe("WebSocket data plane", () => {
  it("echoes a message through the relay", async () => {
    const handle = await client.createSession({ tier: "custom", durationSeconds: 60 });
    await client.waitForReady(handle);
    await client.putFile(handle, {
      path: "ws-echo-server.js",
      data: readFileSync(join(process.cwd(), "scripts/ws-echo-server.js")),
    });
    await client.startService(handle, {
      name: "ws",
      command: ["node", "ws-echo-server.js"],
      port: 18084,
      env: hostPathEnv,
    });
    const ws = await client.openWebSocket(handle, { port: 18084, path: "/" });
    await ws.send("hello-ws");
    let reply = "";
    for (let i = 0; i < 50 && !reply; i++) {
      const part = await ws.read();
      if (part.data) reply = part.data.toString();
      if (part.done) break;
    }
    expect(reply).toBe("hello-ws");
    await ws.close();
    await client.stopService(handle, "ws");
    await client.destroy(handle);
  }, 180_000);
});
