/**
 * Execution and file transfer commands: exec, upload, download, ls and stat.
 *
 * Split out of cli-commands.test.ts. The shared thread is bytes crossing the
 * guest boundary: the request the handler builds (command, env, timeout, path,
 * archive form) and what the operator gets back (streams, exit code, file,
 * listing, coded error). Archive extraction and the unsafe-member refusal live
 * here because they are part of download's contract, not a separate feature.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  execResult,
  fakeClient,
  fileEntry,
  getResult,
  listResult,
  operationError,
  SESSION_ID,
} from "./helpers/cli.js";
import { cliFixture, tarArchive } from "./support/cli-commands.js";

const cli = cliFixture();

describe("exec", () => {
  it("runs the command and forwards both streams", async () => {
    const client = fakeClient({
      exec: vi.fn(async () => execResult({ stdout: "hello", stderr: "warning", exitCode: 0 })),
    });
    const { code, out, err } = await cli.run("exec", client, {
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
    const { code } = await cli.run("exec", client, { positionals: ["exec", SESSION_ID, "false"] });
    expect(code).toBe(3);
  });

  it("clamps a large exit code to 125", async () => {
    const client = fakeClient({ exec: vi.fn(async () => execResult({ exitCode: 4_000 })) });
    const { code } = await cli.run("exec", client, { positionals: ["exec", SESSION_ID, "x"] });
    expect(code).toBe(125);
  });

  it("maps a timeout to 124 and says so", async () => {
    const client = fakeClient({
      exec: vi.fn(async () => execResult({ timedOut: true, exitCode: 137 })),
    });
    const { code, err } = await cli.run("exec", client, { positionals: ["exec", SESSION_ID, "sleep"] });
    expect(code).toBe(124);
    expect(err).toContain("timed out");
  });

  it("maps a rejected operation to 1 with the coded error", async () => {
    const client = fakeClient({ exec: vi.fn(async () => operationError("exec_failed", "no such binary")) });
    const { code, err } = await cli.run("exec", client, { positionals: ["exec", SESSION_ID, "nope"] });
    expect(code).toBe(1);
    expect(err).toContain("error: exec_failed: no such binary");
  });

  it("passes env and a converted timeout", async () => {
    const client = fakeClient();
    await cli.run("exec", client, {
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
      cli.run("exec", fakeClient(), { positionals: ["exec", SESSION_ID, "x"], values: { env: ["NOVALUE"] } }),
    ).rejects.toThrow("invalid --env NOVALUE (expected KEY=VALUE)");
  });

  it("rejects --env with an empty key", async () => {
    await expect(
      cli.run("exec", fakeClient(), { positionals: ["exec", SESSION_ID, "x"], values: { env: ["=1"] } }),
    ).rejects.toThrow("invalid --env =1 (expected KEY=VALUE)");
  });

  it("asks for a command and returns 2", async () => {
    const client = fakeClient();
    const { code, err } = await cli.run("exec", client, { positionals: ["exec", SESSION_ID] });
    expect(code).toBe(2);
    expect(err).toContain("missing command");
    expect(client.exec).not.toHaveBeenCalled();
  });

  it("emits the raw result with --json", async () => {
    const { out } = await cli.run("exec", fakeClient(), {
      positionals: ["exec", SESSION_ID, "x"],
      json: true,
    });
    expect((JSON.parse(out) as { stdout: string }).stdout).toBe("hello\n");
  });

  it("suppresses the exit note when quiet", async () => {
    const { err } = await cli.run("exec", fakeClient(), {
      positionals: ["exec", SESSION_ID, "x"],
      quiet: true,
    });
    expect(err).toBe("");
  });
});

describe("upload", () => {
  it("sends a file as-is", async () => {
    const client = fakeClient();
    const local = join(cli.dir, "a.txt");
    writeFileSync(local, "payload");
    const { code, out } = await cli.run("upload", client, {
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
    const local = join(cli.dir, "tree");
    mkdirSync(local);
    writeFileSync(join(local, "a.txt"), "payload");
    await cli.run("upload", client, { positionals: ["upload", SESSION_ID, local, "/workspace/tree"] });
    const opts = client.putFile.mock.calls[0]![1] as { data: Buffer; archive: boolean };
    expect(opts.archive).toBe(true);
    expect(opts.data.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  });

  it("returns 1 when the guest rejects the upload", async () => {
    const client = fakeClient({ putFile: vi.fn(async () => operationError("file_too_large", "cap is 1Gi")) });
    const local = join(cli.dir, "a.txt");
    writeFileSync(local, "x");
    const { code, err } = await cli.run("upload", client, {
      positionals: ["upload", SESSION_ID, local, "/workspace/a.txt"],
    });
    expect(code).toBe(1);
    expect(err).toContain("error: file_too_large: cap is 1Gi");
  });

  it("requires both paths", async () => {
    await expect(
      cli.run("upload", fakeClient(), { positionals: ["upload", SESSION_ID, join(cli.dir, "a.txt")] }),
    ).rejects.toThrow("missing remote path");
  });
});

describe("download", () => {
  it("writes the decoded bytes", async () => {
    const client = fakeClient({ getFile: vi.fn(async (_h, path: string) => getResult(path, Buffer.from("body"))) });
    const local = join(cli.dir, "out.bin");
    const { code, out } = await cli.run("download", client, {
      positionals: ["download", SESSION_ID, "/workspace/out.bin", local],
    });
    expect(code).toBe(0);
    expect(client.getFile).toHaveBeenCalledWith(expect.anything(), "/workspace/out.bin", false);
    expect(readFileSync(local, "utf8")).toBe("body");
    expect(out).toContain("Downloaded 4 bytes");
  });

  it("asks for the archive form when --extract is set, then unpacks it", async () => {
    // Build a real tarball by uploading a directory through the same handler.
    const source = join(cli.dir, "tree");
    mkdirSync(source);
    writeFileSync(join(source, "a.txt"), "extracted");
    const uploader = fakeClient();
    await cli.run("upload", uploader, { positionals: ["upload", SESSION_ID, source, "/workspace/tree"] });
    const archive = (uploader.putFile.mock.calls[0]![1] as { data: Buffer }).data;

    const client = fakeClient({ getFile: vi.fn(async (_h, path: string) => getResult(path, archive)) });
    const destination = join(cli.dir, "unpacked");
    mkdirSync(destination);
    const { code } = await cli.run("download", client, {
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
    const destination = join(cli.dir, "unpacked");
    mkdirSync(destination);
    await expect(
      cli.run("download", client, {
        positionals: ["download", SESSION_ID, "/workspace/tree", destination],
        values: { extract: true },
      }),
    ).rejects.toThrow("unsafe archive member: ../escape.txt");
  });

  it("returns 1 when the guest rejects the download", async () => {
    const client = fakeClient({ getFile: vi.fn(async () => operationError("not_found", "no such file", "file.get")) });
    const { code, err } = await cli.run("download", client, {
      positionals: ["download", SESSION_ID, "/workspace/nope", join(cli.dir, "nope")],
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
    const { code, out } = await cli.run("ls", client, { positionals: ["ls", SESSION_ID] });
    expect(code).toBe(0);
    // Defaults to the workspace root.
    expect(client.listFiles).toHaveBeenCalledWith(expect.anything(), ".", false);
    expect(out).toContain("d          0  src");
    expect(out).toContain("-         12  src/a.txt");
    expect(out).toContain("2 entries, 12 bytes");
  });

  it("passes --recursive and a path", async () => {
    const client = fakeClient();
    await cli.run("ls", client, { positionals: ["ls", SESSION_ID, "src"], values: { recursive: true } });
    expect(client.listFiles).toHaveBeenCalledWith(expect.anything(), "src", true);
  });

  it("emits entries as JSON", async () => {
    const { out } = await cli.run("ls", fakeClient(), { positionals: ["ls", SESSION_ID], json: true });
    expect((JSON.parse(out) as Array<{ path: string }>)[0]!.path).toBe("a.txt");
  });

  it("returns 1 when the listing is rejected", async () => {
    const client = fakeClient({ listFiles: vi.fn(async () => operationError("not_found", "gone", "file.list")) });
    const { code } = await cli.run("ls", client, { positionals: ["ls", SESSION_ID] });
    expect(code).toBe(1);
  });

  it("prints the stat entry as JSON", async () => {
    const { code, out } = await cli.run("stat", fakeClient(), {
      positionals: ["stat", SESSION_ID, "a.txt"],
    });
    expect(code).toBe(0);
    expect((JSON.parse(out) as { path: string; size: number }).path).toBe("a.txt");
    expect((JSON.parse(out) as { size: number }).size).toBe(5);
  });

  it("returns 1 when stat is rejected", async () => {
    const client = fakeClient({ statFile: vi.fn(async () => operationError("not_found", "gone", "file.stat")) });
    const { code } = await cli.run("stat", client, { positionals: ["stat", SESSION_ID, "a.txt"] });
    expect(code).toBe(1);
  });

  it("requires a path", async () => {
    await expect(cli.run("stat", fakeClient(), { positionals: ["stat", SESSION_ID] })).rejects.toThrow(
      "missing path",
    );
  });
});
