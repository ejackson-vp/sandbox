/**
 * The run command in both forms, plus agent-demo.
 *
 * Split out of cli-commands.test.ts. Everything here answers "run this without
 * managing a session": the legacy `run <file>` form that picks an interpreter
 * from the extension, the one-shot form that uploads inputs, executes and
 * returns files, and agent-demo, which is run with a canned default. They share
 * the interpreter table, the timeout clamp and the returned-file path checks,
 * so they belong in one file rather than three.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  execResult,
  fakeClient,
  operationError,
  SESSION_ID,
  sessionStatus,
} from "./helpers/cli.js";
import { cliFixture } from "./support/cli-commands.js";

const cli = cliFixture();

describe("run with a file (legacy form)", () => {
  it("uploads, executes with the right interpreter and destroys the session", async () => {
    const client = fakeClient();
    const file = join(cli.dir, "hello.py");
    writeFileSync(file, "print('hi')");
    const { code, out } = await cli.run("run", client, { positionals: ["run", file] });
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
    const file = join(cli.dir, name);
    writeFileSync(file, "x");
    await cli.run("run", client, { positionals: ["run", file] });
    expect((client.exec.mock.calls[0]![1] as { command: string[] }).command[0]).toBe(interpreter);
  });

  it("refuses an unknown extension", async () => {
    const client = fakeClient();
    const file = join(cli.dir, "a.txt");
    writeFileSync(file, "x");
    await expect(cli.run("run", client, { positionals: ["run", file] })).rejects.toThrow(
      "don't know how to run",
    );
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it("leaves the session alive with --keep", async () => {
    const client = fakeClient();
    const file = join(cli.dir, "a.py");
    writeFileSync(file, "x");
    await cli.run("run", client, { positionals: ["run", file], values: { keep: true } });
    expect(client.destroy).not.toHaveBeenCalled();
  });

  it("returns 1 when the upload fails", async () => {
    const client = fakeClient({ putFile: vi.fn(async () => operationError("file_too_large", "too big")) });
    const file = join(cli.dir, "a.py");
    writeFileSync(file, "x");
    const { code, err } = await cli.run("run", client, { positionals: ["run", file] });
    expect(code).toBe(1);
    expect(err).toContain("upload failed: file_too_large: too big");
  });

  it("returns 1 when the execution is rejected", async () => {
    const client = fakeClient({ exec: vi.fn(async () => operationError("exec_failed", "boom")) });
    const file = join(cli.dir, "a.py");
    writeFileSync(file, "x");
    const { code, err } = await cli.run("run", client, { positionals: ["run", file] });
    expect(code).toBe(1);
    expect(err).toContain("execution failed: exec_failed: boom");
  });

  it("returns 124 on a timeout", async () => {
    const client = fakeClient({ exec: vi.fn(async () => execResult({ timedOut: true })) });
    const file = join(cli.dir, "a.py");
    writeFileSync(file, "x");
    const { code } = await cli.run("run", client, { positionals: ["run", file] });
    expect(code).toBe(124);
  });

  it("emits the raw result with --json", async () => {
    const client = fakeClient();
    const file = join(cli.dir, "a.py");
    writeFileSync(file, "x");
    const { out } = await cli.run("run", client, { positionals: ["run", file], json: true });
    expect((JSON.parse(out) as { exitCode: number }).exitCode).toBe(0);
  });

  it("caps the timeout at two minutes", async () => {
    const client = fakeClient({ waitForReady: vi.fn(async () => sessionStatus({ remainingSeconds: 3600 })) });
    const file = join(cli.dir, "a.py");
    writeFileSync(file, "x");
    await cli.run("run", client, { positionals: ["run", file] });
    expect((client.exec.mock.calls[0]![1] as { timeoutMs: number }).timeoutMs).toBe(120_000);
  });

  it("uses the remaining lease when it is shorter than two minutes", async () => {
    const client = fakeClient({ waitForReady: vi.fn(async () => sessionStatus({ remainingSeconds: 30 })) });
    const file = join(cli.dir, "a.py");
    writeFileSync(file, "x");
    await cli.run("run", client, { positionals: ["run", file] });
    expect((client.exec.mock.calls[0]![1] as { timeoutMs: number }).timeoutMs).toBe(30_000);
  });

  it("requires a file", async () => {
    await expect(cli.run("run", fakeClient(), { positionals: ["run"] })).rejects.toThrow("missing file");
  });
});

describe("run one-shot", () => {
  it("uploads --file, executes and creates no local return file by default", async () => {
    const client = fakeClient();
    const local = join(cli.dir, "input.txt");
    writeFileSync(local, "in");
    const { code } = await cli.run("run", client, {
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
    await cli.run("run", client, {
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
      await cli.run("run", client, { positionals: ["run", "python3", "x.py"], values });
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
    process.chdir(cli.dir);
    try {
      const { code, err } = await cli.run("run", client, {
        positionals: ["run", "make"],
        hasSeparator: true,
        values: { return: ["out/report.txt"] },
      });
      expect(code).toBe(0);
      expect(readFileSync(join(cli.dir, "out", "report.txt"), "utf8")).toBe("report");
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
    process.chdir(cli.dir);
    try {
      const { code, out } = await cli.run("run", client, {
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
    const { code, err } = await cli.run("run", client, {
      positionals: ["run", "sleep"],
      hasSeparator: true,
    });
    expect(code).toBe(124);
    expect(err).toContain("timed out");
  });

  it("asks for a command and returns 2", async () => {
    const client = fakeClient();
    const { code, err } = await cli.run("run", client, { positionals: ["run"], hasSeparator: true });
    expect(code).toBe(2);
    expect(err).toContain("missing command");
    expect(client.run).not.toHaveBeenCalled();
  });

  it.each(["input.txt", "=remote", "local="])("rejects --file %s", async (spec) => {
    const client = fakeClient();
    const { code, err } = await cli.run("run", client, {
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
        cli.run("run", client, { positionals: ["run", "make"], hasSeparator: true }),
      ).rejects.toThrow(`invalid --return path: ${remote}`);
    },
  );

  it("suppresses progress notes when quiet", async () => {
    const client = fakeClient();
    const { err } = await cli.run("run", client, {
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
    const file = join(cli.dir, "a.py");
    writeFileSync(file, "x");
    const { code } = await cli.run("agent-demo", client, {
      positionals: ["agent-demo", file],
      values: { duration: "1m" },
    });
    expect(code).toBe(0);
    expect(client.createSession).toHaveBeenCalledWith({ tier: "short", durationSeconds: 60 });
  });

  it("defaults to the same standard 300s session as run", async () => {
    const client = fakeClient();
    const file = join(cli.dir, "a.py");
    writeFileSync(file, "x");
    await cli.run("agent-demo", client, { positionals: ["agent-demo", file] });
    expect(client.createSession).toHaveBeenCalledWith({ tier: "standard", durationSeconds: 300 });
  });

  it("honours an explicit tier and --keep through the shared helper", async () => {
    const client = fakeClient();
    const file = join(cli.dir, "a.py");
    writeFileSync(file, "x");
    const { code } = await cli.run("agent-demo", client, {
      positionals: ["agent-demo", file],
      values: { tier: "long", duration: "15m", keep: true },
    });
    expect(code).toBe(0);
    expect(client.createSession).toHaveBeenCalledWith({ tier: "long", durationSeconds: 900 });
    expect(client.destroy).not.toHaveBeenCalled();
  });
});
