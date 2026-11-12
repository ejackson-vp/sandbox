/**
 * Every handler in the CLI command registry, run against a fake client.
 *
 * These assert the two things a CLI test is worth writing for: the request the
 * command builds (options, paths, env, timeouts) and the exit code plus stream
 * the operator gets back. No server, no sockets, no sleeps.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "../../cli/src/commands.js";
import {
  captureWrites,
  cliContext,
  execResult,
  fakeClient,
  fileEntry,
  getResult,
  listResult,
  operationError,
  SESSION_ID,
  sessionHandle,
  sessionStatus,
  type FakeClient,
} from "./helpers/cli.js";

let capture: ReturnType<typeof captureWrites>;
let dir: string;

beforeEach(() => {
  capture = captureWrites();
  dir = mkdtempSync(join(tmpdir(), "x402-cli-"));
});

afterEach(() => {
  capture.restore();
  vi.restoreAllMocks();
});

async function run(
  name: string,
  client: FakeClient,
  overrides: Parameters<typeof cliContext>[1] = {},
): Promise<{ code: number; out: string; err: string }> {
  const code = await commands[name]!(cliContext(client, overrides));
  return { code, out: capture.stdout(), err: capture.stderr() };
}

/**
 * A gzipped tar holding one member. `tar -czf` will not store a `..` member, so
 * the unsafe-archive check has to be handed a hand-built ustar header.
 */
function tarArchive(name: string, body: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100, "utf8");
  header.write("0000000\0", 108, "utf8");
  header.write("0000000\0", 116, "utf8");
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "utf8");
  header.write("00000000000\0", 136, "utf8");
  header.fill(" ", 148, 156);
  header.write("0", 156, "utf8");
  header.write("ustar", 257, "utf8");
  header.write("00", 263, "utf8");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
  const data = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  data.write(body, 0, "utf8");
  return gzipSync(Buffer.concat([header, data, Buffer.alloc(1024)]));
}

describe("create", () => {
  it("pays, waits for ready and reports the lease", async () => {
    const client = fakeClient();
    client.createSession.mockImplementation(async () => ({ ...sessionHandle(), status: sessionStatus() }));
    const { code, out } = await run("create", client);
    expect(code).toBe(0);
    expect(client.createSession).toHaveBeenCalledWith({});
    expect(client.waitForReady).toHaveBeenCalledTimes(1);
    expect(out).toContain(`Session: ${SESSION_ID}`);
    expect(out).toContain("Tier: standard (300s, 1000m CPU, 1024Mi RAM, 1024Mi disk)");
    expect(out).toContain("Price: $0.05 (mock payment)");
    expect(out).toContain("Evidence: none (session key binding, no hardware root of trust)");
    expect(out).toContain("Expires: ? (120s remaining)");
  });

  it("falls back to PAID and an unknown price when the create response omits status", async () => {
    const { out } = await run("create", fakeClient());
    expect(out).toContain("State: PAID");
    expect(out).toContain("Price: ? (mock payment)");
    expect(out).not.toContain("Tier:");
  });

  it("skips the wait with --no-wait", async () => {
    const client = fakeClient();
    const { out } = await run("create", client, { values: { "no-wait": true } });
    expect(client.waitForReady).not.toHaveBeenCalled();
    expect(out).not.toContain("Evidence:");
  });

  it("emits one JSON object with --json", async () => {
    const client = fakeClient();
    client.createSession.mockImplementation(async () => ({ ...sessionHandle(), status: sessionStatus() }));
    const { out } = await run("create", client, { json: true });
    const parsed = JSON.parse(out) as { sessionId: string; status: { state: string } };
    expect(parsed.sessionId).toBe(SESSION_ID);
    expect(parsed.status.state).toBe("READY");
    expect(out).not.toContain("Session: ");
  });

  it.each([
    [{ duration: "15m" }, { tier: "extended", durationSeconds: 900 }],
    [{ duration: "60s" }, { tier: "short", durationSeconds: 60 }],
    [{ duration: "1800" }, { tier: "long", durationSeconds: 1800 }],
    [{ duration: "45s" }, { tier: "custom", durationSeconds: 45 }],
    [{ duration: "1h" }, { tier: "custom", durationSeconds: 3600 }],
    [{ tier: "long", duration: "15m" }, { tier: "long", durationSeconds: 900 }],
    [{ tier: "standard" }, { tier: "standard" }],
    [{ cpu: "1" }, { cpuMillis: 1000 }],
    [{ cpu: "0.25" }, { cpuMillis: 250 }],
    [{ memory: "2Gi" }, { memoryMiB: 2048 }],
    [{ memory: "512Mi" }, { memoryMiB: 512 }],
    [{ memory: "512" }, { memoryMiB: 512 }],
    [{ disk: "1Gi" }, { diskMiB: 1024 }],
    [{ "baseline-cpu": "0.25" }, { baselineCpuMillis: 250 }],
    [{ "baseline-memory": "256Mi" }, { baselineMemoryMiB: 256 }],
    [{ "max-lifetime": "8h" }, { maxLifetimeSeconds: 28800 }],
    [{ runtime: "python" }, { runtime: "python" }],
    [
      { idle: "5m" },
      { idlePolicy: { maxIdleSeconds: 300, suspendedDurationSeconds: 28800, autoResume: false } },
    ],
    [
      { duration: "15m", cpu: "2", memory: "4Gi", idle: "1m", runtime: "node" },
      {
        tier: "extended",
        durationSeconds: 900,
        cpuMillis: 2000,
        memoryMiB: 4096,
        idlePolicy: { maxIdleSeconds: 60, suspendedDurationSeconds: 28800, autoResume: false },
        runtime: "node",
      },
    ],
  ])("maps %j to create options", async (values, expected) => {
    const client = fakeClient();
    await run("create", client, { values: values as Record<string, string> });
    expect(client.createSession).toHaveBeenCalledWith(expected);
  });

  it.each([
    [{ duration: "15x" }, "invalid duration: 15x"],
    [{ duration: "-5m" }, "invalid duration: -5m"],
    [{ memory: "2GB" }, "invalid memory: 2GB"],
    [{ disk: "2 GB" }, "invalid memory: 2 GB"],
    [{ cpu: "0" }, "invalid cpu: 0"],
    [{ cpu: "lots" }, "invalid cpu: lots"],
  ])("rejects %j with %s", async (values, message) => {
    const client = fakeClient();
    await expect(run("create", client, { values: values as Record<string, string> })).rejects.toThrow(
      message,
    );
    expect(client.createSession).not.toHaveBeenCalled();
  });
});

describe("status", () => {
  it("prints the summary and every optional section", async () => {
    const client = fakeClient({
      status: vi.fn(async () =>
        sessionStatus({
          readyAt: "2026-01-01T00:00:01.000Z",
          leaseExpiresAt: "2026-01-01T00:05:00.000Z",
          baseline: { cpuMillis: 250, memoryMiB: 256 },
          idlePolicy: { maxIdleSeconds: 300, autoResume: true },
          suspendedAt: "2026-01-01T00:02:00.000Z",
          resumeCount: 2,
          failure: { code: "guest_crash", message: "the guest died" },
        }),
      ),
    });
    const { code, out } = await run("status", client, { positionals: ["status", SESSION_ID] });
    expect(code).toBe(0);
    expect(out).toContain(`Session: ${SESSION_ID}`);
    expect(out).toContain("State: READY");
    expect(out).toContain("Tier: standard (300s)");
    expect(out).toContain("Limits: 1000m CPU, 1024Mi RAM, 1024Mi disk");
    expect(out).toContain("Ready: 2026-01-01T00:00:01.000Z");
    expect(out).toContain("Expires: 2026-01-01T00:05:00.000Z (120s remaining)");
    expect(out).toContain("Baseline: 250m CPU, 256Mi RAM");
    expect(out).toContain("Idle policy: maxIdle 300s, autoResume true");
    expect(out).toContain("Suspended: 2026-01-01T00:02:00.000Z");
    expect(out).toContain("Resumes: 2");
    expect(out).toContain("Failure: guest_crash: the guest died");
    expect(out).toContain("Busy: false");
  });

  it("omits sections that are absent", async () => {
    const { out } = await run("status", fakeClient(), { positionals: ["status", SESSION_ID] });
    expect(out).not.toContain("Ready:");
    expect(out).not.toContain("Baseline:");
    expect(out).not.toContain("Failure:");
  });

  it("emits the raw status with --json", async () => {
    const { out } = await run("status", fakeClient(), {
      positionals: ["status", SESSION_ID],
      json: true,
    });
    expect((JSON.parse(out) as { sessionId: string }).sessionId).toBe(SESSION_ID);
  });

  it("requires a session id", async () => {
    await expect(run("status", fakeClient(), { positionals: ["status"] })).rejects.toThrow(
      "missing session id",
    );
  });
});

describe("exec", () => {
  it("runs the command and forwards both streams", async () => {
    const client = fakeClient({
      exec: vi.fn(async () => execResult({ stdout: "hello", stderr: "warning", exitCode: 0 })),
    });
    const { code, out, err } = await run("exec", client, {
      positionals: ["exec", SESSION_ID, "echo", "hello"],
    });
    expect(code).toBe(0);
    expect(client.exec).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SESSION_ID }), {
      command: ["echo", "hello"],
    });
    // A missing trailing newline is added so the note starts on its own line.
    expect(out).toBe("hello\n");
    expect(err).toBe("warning\nexit 0 (12ms)\n");
  });

  it("returns the guest exit code", async () => {
    const client = fakeClient({ exec: vi.fn(async () => execResult({ exitCode: 3, stdout: "" })) });
    const { code } = await run("exec", client, { positionals: ["exec", SESSION_ID, "false"] });
    expect(code).toBe(3);
  });

  it("clamps a large exit code to 125", async () => {
    const client = fakeClient({ exec: vi.fn(async () => execResult({ exitCode: 4_000 })) });
    const { code } = await run("exec", client, { positionals: ["exec", SESSION_ID, "x"] });
    expect(code).toBe(125);
  });

  it("maps a timeout to 124 and says so", async () => {
    const client = fakeClient({
      exec: vi.fn(async () => execResult({ timedOut: true, exitCode: 137 })),
    });
    const { code, err } = await run("exec", client, { positionals: ["exec", SESSION_ID, "sleep"] });
    expect(code).toBe(124);
    expect(err).toContain("timed out");
  });

  it("maps a rejected operation to 1 with the coded error", async () => {
    const client = fakeClient({ exec: vi.fn(async () => operationError("exec_failed", "no such binary")) });
    const { code, err } = await run("exec", client, { positionals: ["exec", SESSION_ID, "nope"] });
    expect(code).toBe(1);
    expect(err).toContain("error: exec_failed: no such binary");
  });

  it("passes env and a converted timeout", async () => {
    const client = fakeClient();
    await run("exec", client, {
      positionals: ["exec", SESSION_ID, "env"],
      values: { env: ["A=1", "B=two=2"], timeout: "30s" },
    });
    expect(client.exec).toHaveBeenCalledWith(expect.anything(), {
      command: ["env"],
      env: { A: "1", B: "two=2" },
      timeoutMs: 30_000,
    });
  });

  it("rejects a malformed --env", async () => {
    await expect(
      run("exec", fakeClient(), { positionals: ["exec", SESSION_ID, "x"], values: { env: ["NOVALUE"] } }),
    ).rejects.toThrow("invalid --env NOVALUE (expected KEY=VALUE)");
  });

  it("rejects --env with an empty key", async () => {
    await expect(
      run("exec", fakeClient(), { positionals: ["exec", SESSION_ID, "x"], values: { env: ["=1"] } }),
    ).rejects.toThrow("invalid --env =1 (expected KEY=VALUE)");
  });

  it("asks for a command and returns 2", async () => {
    const client = fakeClient();
    const { code, err } = await run("exec", client, { positionals: ["exec", SESSION_ID] });
    expect(code).toBe(2);
    expect(err).toContain("missing command");
    expect(client.exec).not.toHaveBeenCalled();
  });

  it("emits the raw result with --json", async () => {
    const { out } = await run("exec", fakeClient(), {
      positionals: ["exec", SESSION_ID, "x"],
      json: true,
    });
    expect((JSON.parse(out) as { stdout: string }).stdout).toBe("hello\n");
  });

  it("suppresses the exit note when quiet", async () => {
    const { err } = await run("exec", fakeClient(), {
      positionals: ["exec", SESSION_ID, "x"],
      quiet: true,
    });
    expect(err).toBe("");
  });
});

describe("upload", () => {
  it("sends a file as-is", async () => {
    const client = fakeClient();
    const local = join(dir, "a.txt");
    writeFileSync(local, "payload");
    const { code, out } = await run("upload", client, {
      positionals: ["upload", SESSION_ID, local, "/workspace/a.txt"],
    });
    expect(code).toBe(0);
    const opts = client.putFile.mock.calls[0]![1] as { path: string; data: Buffer; archive: boolean };
    expect(opts.path).toBe("/workspace/a.txt");
    expect(opts.archive).toBe(false);
    expect(opts.data.toString()).toBe("payload");
    expect(out).toContain("Uploaded 1 file(s), 7 bytes to /workspace/a.txt");
  });

  it("packs a directory into a tar archive", async () => {
    const client = fakeClient();
    const local = join(dir, "tree");
    mkdirSync(local);
    writeFileSync(join(local, "a.txt"), "payload");
    await run("upload", client, { positionals: ["upload", SESSION_ID, local, "/workspace/tree"] });
    const opts = client.putFile.mock.calls[0]![1] as { data: Buffer; archive: boolean };
    expect(opts.archive).toBe(true);
    expect(opts.data.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  });

  it("returns 1 when the guest rejects the upload", async () => {
    const client = fakeClient({ putFile: vi.fn(async () => operationError("file_too_large", "cap is 1Gi")) });
    const local = join(dir, "a.txt");
    writeFileSync(local, "x");
    const { code, err } = await run("upload", client, {
      positionals: ["upload", SESSION_ID, local, "/workspace/a.txt"],
    });
    expect(code).toBe(1);
    expect(err).toContain("error: file_too_large: cap is 1Gi");
  });

  it("requires both paths", async () => {
    await expect(
      run("upload", fakeClient(), { positionals: ["upload", SESSION_ID, join(dir, "a.txt")] }),
    ).rejects.toThrow("missing remote path");
  });
});

describe("download", () => {
  it("writes the decoded bytes", async () => {
    const client = fakeClient({ getFile: vi.fn(async (_h, path: string) => getResult(path, Buffer.from("body"))) });
    const local = join(dir, "out.bin");
    const { code, out } = await run("download", client, {
      positionals: ["download", SESSION_ID, "/workspace/out.bin", local],
    });
    expect(code).toBe(0);
    expect(client.getFile).toHaveBeenCalledWith(expect.anything(), "/workspace/out.bin", false);
    expect(readFileSync(local, "utf8")).toBe("body");
    expect(out).toContain("Downloaded 4 bytes");
  });

  it("asks for the archive form when --extract is set, then unpacks it", async () => {
    // Build a real tarball by uploading a directory through the same handler.
    const source = join(dir, "tree");
    mkdirSync(source);
    writeFileSync(join(source, "a.txt"), "extracted");
    const uploader = fakeClient();
    await run("upload", uploader, { positionals: ["upload", SESSION_ID, source, "/workspace/tree"] });
    const archive = (uploader.putFile.mock.calls[0]![1] as { data: Buffer }).data;

    const client = fakeClient({ getFile: vi.fn(async (_h, path: string) => getResult(path, archive)) });
    const destination = join(dir, "unpacked");
    mkdirSync(destination);
    const { code } = await run("download", client, {
      positionals: ["download", SESSION_ID, "/workspace/tree", destination],
      values: { extract: true },
    });
    expect(code).toBe(0);
    expect(client.getFile).toHaveBeenCalledWith(expect.anything(), "/workspace/tree", true);
    // tarDirectory stores the directory itself as the first path segment.
    expect(readFileSync(join(destination, "tree", "a.txt"), "utf8")).toBe("extracted");
  });

  it("refuses an archive member that escapes the destination", async () => {
    const client = fakeClient({
      getFile: vi.fn(async (_h, path: string) => getResult(path, tarArchive("../escape.txt", "boom"))),
    });
    const destination = join(dir, "unpacked");
    mkdirSync(destination);
    await expect(
      run("download", client, {
        positionals: ["download", SESSION_ID, "/workspace/tree", destination],
        values: { extract: true },
      }),
    ).rejects.toThrow("unsafe archive member: ../escape.txt");
  });

  it("returns 1 when the guest rejects the download", async () => {
    const client = fakeClient({ getFile: vi.fn(async () => operationError("not_found", "no such file", "file.get")) });
    const { code, err } = await run("download", client, {
      positionals: ["download", SESSION_ID, "/workspace/nope", join(dir, "nope")],
    });
    expect(code).toBe(1);
    expect(err).toContain("error: not_found: no such file");
  });
});

describe("ls and stat", () => {
  it("prints a listing with a directory marker and totals", async () => {
    const client = fakeClient({
      listFiles: vi.fn(async (_h, path: string) =>
        listResult(path, [
          fileEntry({ path: "src", isDir: true, size: 0 }),
          fileEntry({ path: "src/a.txt", size: 12 }),
        ]),
      ),
    });
    const { code, out } = await run("ls", client, { positionals: ["ls", SESSION_ID] });
    expect(code).toBe(0);
    // Defaults to the workspace root.
    expect(client.listFiles).toHaveBeenCalledWith(expect.anything(), ".", false);
    expect(out).toContain("d          0  src");
    expect(out).toContain("-         12  src/a.txt");
    expect(out).toContain("2 entries, 12 bytes");
  });

  it("passes --recursive and a path", async () => {
    const client = fakeClient();
    await run("ls", client, { positionals: ["ls", SESSION_ID, "src"], values: { recursive: true } });
    expect(client.listFiles).toHaveBeenCalledWith(expect.anything(), "src", true);
  });

  it("emits entries as JSON", async () => {
    const { out } = await run("ls", fakeClient(), { positionals: ["ls", SESSION_ID], json: true });
    expect((JSON.parse(out) as Array<{ path: string }>)[0]!.path).toBe("a.txt");
  });

  it("returns 1 when the listing is rejected", async () => {
    const client = fakeClient({ listFiles: vi.fn(async () => operationError("not_found", "gone", "file.list")) });
    const { code } = await run("ls", client, { positionals: ["ls", SESSION_ID] });
    expect(code).toBe(1);
  });

  it("prints the stat entry as JSON", async () => {
    const { code, out } = await run("stat", fakeClient(), {
      positionals: ["stat", SESSION_ID, "a.txt"],
    });
    expect(code).toBe(0);
    expect((JSON.parse(out) as { path: string; size: number }).path).toBe("a.txt");
    expect((JSON.parse(out) as { size: number }).size).toBe(5);
  });

  it("returns 1 when stat is rejected", async () => {
    const client = fakeClient({ statFile: vi.fn(async () => operationError("not_found", "gone", "file.stat")) });
    const { code } = await run("stat", client, { positionals: ["stat", SESSION_ID, "a.txt"] });
    expect(code).toBe(1);
  });

  it("requires a path", async () => {
    await expect(run("stat", fakeClient(), { positionals: ["stat", SESSION_ID] })).rejects.toThrow(
      "missing path",
    );
  });
});

describe("suspend and resume", () => {
  it("prints the new state", async () => {
    const { code, out } = await run("suspend", fakeClient(), {
      positionals: ["suspend", SESSION_ID],
    });
    expect(code).toBe(0);
    expect(out).toBe("State: SUSPENDED\n");
  });

  it("prints the resume state and JSON body", async () => {
    const { code, out } = await run("resume", fakeClient(), {
      positionals: ["resume", SESSION_ID],
      json: true,
    });
    expect(code).toBe(0);
    expect(out).not.toContain("State: READY");
    expect((JSON.parse(out) as { resumeCount: number }).resumeCount).toBe(1);
  });
});

describe("serve, services and stop-service", () => {
  it("starts a service with the defaults", async () => {
    const client = fakeClient();
    const { code, out } = await run("serve", client, {
      positionals: ["serve", SESSION_ID, "python3", "-m", "http.server"],
    });
    expect(code).toBe(0);
    expect(client.startService).toHaveBeenCalledWith(expect.anything(), {
      name: "web",
      port: 8080,
      command: ["python3", "-m", "http.server"],
    });
    expect(out).toContain("Service: web on 127.0.0.1:8080 (pid 42, running)");
  });

  it("honours --name, --port and --json", async () => {
    const client = fakeClient();
    const { out } = await run("serve", client, {
      positionals: ["serve", SESSION_ID, "node", "server.js"],
      values: { name: "api", port: "3000" },
      json: true,
    });
    expect(client.startService).toHaveBeenCalledWith(expect.anything(), {
      name: "api",
      port: 3000,
      command: ["node", "server.js"],
    });
    expect((JSON.parse(out) as { port: number }).port).toBe(3000);
  });

  it("asks for a command and returns 2", async () => {
    const client = fakeClient();
    const { code, err } = await run("serve", client, { positionals: ["serve", SESSION_ID] });
    expect(code).toBe(2);
    expect(err).toContain("serve requires -- <command>");
    expect(client.startService).not.toHaveBeenCalled();
  });

  it("says so when no service is running", async () => {
    const { out } = await run("services", fakeClient(), { positionals: ["services", SESSION_ID] });
    expect(out).toBe("No services\n");
  });

  it("prints a service table", async () => {
    const client = fakeClient({
      listServices: vi.fn(async () => [
        { name: "web", state: "running", port: 8080, pid: 42, startedAt: 0 },
      ]),
    });
    const { out } = await run("services", client, { positionals: ["services", SESSION_ID] });
    expect(out).toBe("web\trunning\t127.0.0.1:8080\tpid 42\n");
  });

  it("prints services as JSON", async () => {
    const client = fakeClient({
      listServices: vi.fn(async () => [
        { name: "web", state: "running", port: 8080, pid: 42, startedAt: 0 },
      ]),
    });
    const { out } = await run("services", client, { positionals: ["services", SESSION_ID], json: true });
    expect((JSON.parse(out) as unknown[]).length).toBe(1);
  });

  it("stops a named service", async () => {
    const client = fakeClient();
    const { code, out } = await run("stop-service", client, {
      positionals: ["stop-service", SESSION_ID, "web"],
    });
    expect(code).toBe(0);
    expect(client.stopService).toHaveBeenCalledWith(expect.anything(), "web");
    expect(out).toBe("Service web: stopped\n");
  });

  it("requires a service name", async () => {
    await expect(
      run("stop-service", fakeClient(), { positionals: ["stop-service", SESSION_ID] }),
    ).rejects.toThrow("missing service name");
  });
});

describe("http", () => {
  it("prints the status line and the body", async () => {
    const client = fakeClient();
    const { code, out } = await run("http", client, { positionals: ["http", SESSION_ID, "8080"] });
    expect(code).toBe(0);
    expect(client.http).toHaveBeenCalledWith(expect.anything(), {
      port: 8080,
      path: "/",
      method: "GET",
    });
    expect(out).toBe("HTTP 200\nok");
  });

  it("passes method, path and body", async () => {
    const client = fakeClient();
    await run("http", client, {
      positionals: ["http", SESSION_ID, "8080", "/submit"],
      values: { method: "POST", body: "x=1" },
    });
    expect(client.http).toHaveBeenCalledWith(expect.anything(), {
      port: 8080,
      path: "/submit",
      method: "POST",
      body: "x=1",
    });
  });

  it("notes a truncated body on stderr", async () => {
    const client = fakeClient({
      http: vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.from("cut"), truncated: true })),
    });
    const { err } = await run("http", client, { positionals: ["http", SESSION_ID, "8080"] });
    expect(err).toContain("[response truncated]");
  });

  it("emits base64 body, headers and status with --json", async () => {
    const { out } = await run("http", fakeClient(), {
      positionals: ["http", SESSION_ID, "8080"],
      json: true,
    });
    const parsed = JSON.parse(out) as { status: number; body: string; truncated: boolean };
    expect(parsed.status).toBe(200);
    expect(Buffer.from(parsed.body, "base64").toString()).toBe("ok");
    expect(parsed.truncated).toBe(false);
  });

  it("streams the response and closes the stream", async () => {
    const parts = [{ chunk: Buffer.from("one"), done: false }, { chunk: Buffer.from("two"), done: true }];
    const close = vi.fn(async () => undefined);
    const client = fakeClient({
      openHttpStream: vi.fn(async () => ({
        streamId: "s1",
        status: 200,
        headers: {},
        read: vi.fn(async () => parts.shift() ?? { done: true }),
        close,
      })),
    });
    const { code, out } = await run("http", client, {
      positionals: ["http", SESSION_ID, "8080"],
      values: { stream: true },
    });
    expect(code).toBe(0);
    expect(out).toBe("onetwo");
    expect(close).toHaveBeenCalledTimes(1);
    expect(client.http).not.toHaveBeenCalled();
  });
});

describe("destroy", () => {
  it("reports the destroyed state", async () => {
    const { code, out } = await run("destroy", fakeClient(), {
      positionals: ["destroy", SESSION_ID],
    });
    expect(code).toBe(0);
    expect(out).toBe("Sandbox: destroyed\n");
  });

  it("handles a client that returns no status", async () => {
    const client = fakeClient({ destroy: vi.fn(async () => null) });
    const { out } = await run("destroy", client, { positionals: ["destroy", SESSION_ID] });
    expect(out).toBe("Sandbox: destroyed\n");
  });

  it("emits the id and state with --json", async () => {
    const { out } = await run("destroy", fakeClient(), {
      positionals: ["destroy", SESSION_ID],
      json: true,
    });
    expect(JSON.parse(out)).toEqual({ sessionId: SESSION_ID, state: "DESTROYED" });
  });
});

describe("run with a file (legacy form)", () => {
  it("uploads, executes with the right interpreter and destroys the session", async () => {
    const client = fakeClient();
    const file = join(dir, "hello.py");
    writeFileSync(file, "print('hi')");
    const { code, out } = await run("run", client, { positionals: ["run", file] });
    expect(code).toBe(0);
    expect(client.createSession).toHaveBeenCalledWith({ tier: "standard", durationSeconds: 300 });
    expect(client.putFile).toHaveBeenCalledWith(expect.anything(), {
      path: "/workspace/hello.py",
      data: Buffer.from("print('hi')"),
    });
    expect(client.exec).toHaveBeenCalledWith(expect.anything(), {
      command: ["python3", "/workspace/hello.py"],
      timeoutMs: 120_000,
    });
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(out).toContain("Session: ");
    expect(out).toContain("Exit code: 0");
    expect(out).toContain("Execution: 0.0s");
    expect(out).toContain("Sandbox: destroyed");
  });

  it.each([
    ["a.js", "node"],
    ["a.mjs", "node"],
    ["a.sh", "bash"],
    ["a.py", "python3"],
  ])("runs %s with %s", async (name, interpreter) => {
    const client = fakeClient();
    const file = join(dir, name);
    writeFileSync(file, "x");
    await run("run", client, { positionals: ["run", file] });
    expect((client.exec.mock.calls[0]![1] as { command: string[] }).command[0]).toBe(interpreter);
  });

  it("refuses an unknown extension", async () => {
    const client = fakeClient();
    const file = join(dir, "a.txt");
    writeFileSync(file, "x");
    await expect(run("run", client, { positionals: ["run", file] })).rejects.toThrow(
      "don't know how to run",
    );
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it("leaves the session alive with --keep", async () => {
    const client = fakeClient();
    const file = join(dir, "a.py");
    writeFileSync(file, "x");
    await run("run", client, { positionals: ["run", file], values: { keep: true } });
    expect(client.destroy).not.toHaveBeenCalled();
  });

  it("returns 1 when the upload fails", async () => {
    const client = fakeClient({ putFile: vi.fn(async () => operationError("file_too_large", "too big")) });
    const file = join(dir, "a.py");
    writeFileSync(file, "x");
    const { code, err } = await run("run", client, { positionals: ["run", file] });
    expect(code).toBe(1);
    expect(err).toContain("upload failed: file_too_large: too big");
  });

  it("returns 1 when the execution is rejected", async () => {
    const client = fakeClient({ exec: vi.fn(async () => operationError("exec_failed", "boom")) });
    const file = join(dir, "a.py");
    writeFileSync(file, "x");
    const { code, err } = await run("run", client, { positionals: ["run", file] });
    expect(code).toBe(1);
    expect(err).toContain("execution failed: exec_failed: boom");
  });

  it("returns 124 on a timeout", async () => {
    const client = fakeClient({ exec: vi.fn(async () => execResult({ timedOut: true })) });
    const file = join(dir, "a.py");
    writeFileSync(file, "x");
    const { code } = await run("run", client, { positionals: ["run", file] });
    expect(code).toBe(124);
  });

  it("emits the raw result with --json", async () => {
    const client = fakeClient();
    const file = join(dir, "a.py");
    writeFileSync(file, "x");
    const { out } = await run("run", client, { positionals: ["run", file], json: true });
    expect((JSON.parse(out) as { exitCode: number }).exitCode).toBe(0);
  });

  it("caps the timeout at two minutes", async () => {
    const client = fakeClient({ waitForReady: vi.fn(async () => sessionStatus({ remainingSeconds: 3600 })) });
    const file = join(dir, "a.py");
    writeFileSync(file, "x");
    await run("run", client, { positionals: ["run", file] });
    expect((client.exec.mock.calls[0]![1] as { timeoutMs: number }).timeoutMs).toBe(120_000);
  });

  it("uses the remaining lease when it is shorter than two minutes", async () => {
    const client = fakeClient({ waitForReady: vi.fn(async () => sessionStatus({ remainingSeconds: 30 })) });
    const file = join(dir, "a.py");
    writeFileSync(file, "x");
    await run("run", client, { positionals: ["run", file] });
    expect((client.exec.mock.calls[0]![1] as { timeoutMs: number }).timeoutMs).toBe(30_000);
  });

  it("requires a file", async () => {
    await expect(run("run", fakeClient(), { positionals: ["run"] })).rejects.toThrow("missing file");
  });
});

describe("run one-shot", () => {
  it("uploads --file, executes and creates no local return file by default", async () => {
    const client = fakeClient();
    const local = join(dir, "input.txt");
    writeFileSync(local, "in");
    const { code } = await run("run", client, {
      positionals: ["run", "cat", "input.txt"],
      hasSeparator: true,
      values: { file: [`${local}=input.txt`] },
    });
    expect(code).toBe(0);
    const opts = client.run.mock.calls[0]![0] as {
      command: string[];
      files: Record<string, Uint8Array>;
    };
    expect(opts.command).toEqual(["cat", "input.txt"]);
    expect(Object.keys(opts.files)).toEqual(["input.txt"]);
    expect([...opts.files["input.txt"]!]).toEqual([...Buffer.from("in")]);
  });

  it("passes create options, env and a converted timeout", async () => {
    const client = fakeClient();
    await run("run", client, {
      positionals: ["run", "make"],
      hasSeparator: true,
      values: { duration: "15m", cpu: "2", env: ["A=1"], timeout: "45s" },
    });
    expect(client.run).toHaveBeenCalledWith({
      tier: "extended",
      durationSeconds: 900,
      cpuMillis: 2000,
      command: ["make"],
      env: { A: "1" },
      timeoutMs: 45_000,
    });
  });

  it("treats --runtime, --file and --return as the one-shot form even without --", async () => {
    for (const values of [{ runtime: "python" }, { return: ["out.txt"] }]) {
      const client = fakeClient();
      await run("run", client, { positionals: ["run", "python3", "x.py"], values });
      expect(client.run, JSON.stringify(values)).toHaveBeenCalledTimes(1);
      expect(client.createSession).not.toHaveBeenCalled();
    }
  });

  it("writes returned files and reports them", async () => {
    const client = fakeClient({
      run: vi.fn(async () => ({
        sessionId: SESSION_ID,
        exitCode: 0,
        stdout: "",
        stderr: "",
        files: { "/workspace/out/report.txt": Buffer.from("report") },
        durationMs: 5,
        timedOut: false,
        cancelled: false,
      })),
    });
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const { code, err } = await run("run", client, {
        positionals: ["run", "make"],
        hasSeparator: true,
        values: { return: ["out/report.txt"] },
      });
      expect(code).toBe(0);
      expect(readFileSync(join(dir, "out", "report.txt"), "utf8")).toBe("report");
      expect(err).toContain(`Wrote /workspace/out/report.txt -> out/report.txt`);
      expect((client.run.mock.calls[0]![0] as { returnFiles: string[] }).returnFiles).toEqual([
        "out/report.txt",
      ]);
    } finally {
      process.chdir(cwd);
    }
  });

  it("emits stdout, base64 files and exit data with --json", async () => {
    const client = fakeClient({
      run: vi.fn(async () => ({
        sessionId: SESSION_ID,
        exitCode: 2,
        stdout: "out\n",
        stderr: "bad\n",
        files: { "/workspace/out.txt": Buffer.from("body") },
        durationMs: 9,
        timedOut: false,
        cancelled: false,
      })),
    });
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const { code, out } = await run("run", client, {
        positionals: ["run", "make"],
        hasSeparator: true,
        json: true,
      });
      expect(code).toBe(2);
      const parsed = JSON.parse(out) as {
        exitCode: number;
        stdout: string;
        files: Record<string, string>;
        written: Record<string, string>;
      };
      expect(parsed.exitCode).toBe(2);
      expect(parsed.stdout).toBe("out\n");
      expect(Buffer.from(parsed.files["/workspace/out.txt"]!, "base64").toString()).toBe("body");
      expect(parsed.written).toEqual({ "/workspace/out.txt": "out.txt" });
    } finally {
      process.chdir(cwd);
    }
  });

  it("maps a timeout to 124", async () => {
    const client = fakeClient({
      run: vi.fn(async () => ({
        sessionId: SESSION_ID,
        exitCode: 1,
        stdout: "",
        stderr: "",
        files: {},
        durationMs: 1,
        timedOut: true,
        cancelled: false,
      })),
    });
    const { code, err } = await run("run", client, {
      positionals: ["run", "sleep"],
      hasSeparator: true,
    });
    expect(code).toBe(124);
    expect(err).toContain("timed out");
  });

  it("asks for a command and returns 2", async () => {
    const client = fakeClient();
    const { code, err } = await run("run", client, { positionals: ["run"], hasSeparator: true });
    expect(code).toBe(2);
    expect(err).toContain("missing command");
    expect(client.run).not.toHaveBeenCalled();
  });

  it.each(["input.txt", "=remote", "local="])("rejects --file %s", async (spec) => {
    const client = fakeClient();
    const { code, err } = await run("run", client, {
      positionals: ["run", "ls"],
      hasSeparator: true,
      values: { file: [spec] },
    });
    expect(code).toBe(2);
    expect(err).toContain(`invalid --file ${spec}`);
  });

  it.each([["/etc/passwd"], ["../../escape"], ["a/../../b"]])(
    "refuses to write a returned file to %s",
    async (remote) => {
      const client = fakeClient({
        run: vi.fn(async () => ({
          sessionId: SESSION_ID,
          exitCode: 0,
          stdout: "",
          stderr: "",
          files: { [remote]: Buffer.from("x") },
          durationMs: 1,
          timedOut: false,
          cancelled: false,
        })),
      });
      await expect(
        run("run", client, { positionals: ["run", "make"], hasSeparator: true }),
      ).rejects.toThrow(`invalid --return path: ${remote}`);
    },
  );

  it("suppresses progress notes when quiet", async () => {
    const client = fakeClient();
    const { err } = await run("run", client, {
      positionals: ["run", "make"],
      hasSeparator: true,
      quiet: true,
    });
    expect(err).toBe("");
  });
});

describe("agent-demo", () => {
  it("runs a local file the same way as run", async () => {
    const client = fakeClient();
    const file = join(dir, "a.py");
    writeFileSync(file, "x");
    const { code } = await run("agent-demo", client, {
      positionals: ["agent-demo", file],
      values: { duration: "1m" },
    });
    expect(code).toBe(0);
    expect(client.createSession).toHaveBeenCalledWith({ tier: "short", durationSeconds: 60 });
  });

  it("defaults to the same standard 300s session as run", async () => {
    const client = fakeClient();
    const file = join(dir, "a.py");
    writeFileSync(file, "x");
    await run("agent-demo", client, { positionals: ["agent-demo", file] });
    expect(client.createSession).toHaveBeenCalledWith({ tier: "standard", durationSeconds: 300 });
  });

  it("honours an explicit tier and --keep through the shared helper", async () => {
    const client = fakeClient();
    const file = join(dir, "a.py");
    writeFileSync(file, "x");
    const { code } = await run("agent-demo", client, {
      positionals: ["agent-demo", file],
      values: { tier: "long", duration: "15m", keep: true },
    });
    expect(code).toBe(0);
    expect(client.createSession).toHaveBeenCalledWith({ tier: "long", durationSeconds: 900 });
    expect(client.destroy).not.toHaveBeenCalled();
  });
});
