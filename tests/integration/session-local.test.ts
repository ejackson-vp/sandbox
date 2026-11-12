/**
 * Session supervisor tests against the real Go guest (local process, no
 * Kubernetes). Covers multi-command sessions, exec semantics, timeouts,
 * cancellation, the workspace filesystem, archives, path safety and the lease.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { expectGuestOk, GuestHarness } from "../helpers/guest.js";
import { makeTar } from "../helpers/tar.js";
import { hostPathEnv } from "./dev-path.js";
import { testPort } from "./ports.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let guest: GuestHarness;

beforeAll(async () => {
  guest = new GuestHarness({
    port: testPort(18500),
    leaseSeconds: 120,
    maxDiskMiB: 2,
    maxFileBytes: 8 * 1024 * 1024,
    maxOutputBytes: 64 * 1024,
  });
  await guest.start();
});

afterAll(async () => {
  await guest?.stop();
});

describe("multi-command session", () => {
  it("persists filesystem state between commands", async () => {
    const first = expectGuestOk(
      await guest.exec(["bash", "-c", "pwd && mkdir -p sub && echo hello > sub/test.txt"]),
      "exec",
    );
    expect(first.exitCode).toBe(0);
    expect(first.stdout.trim()).toMatch(/\/workspace$/);

    const second = expectGuestOk(await guest.exec(["cat", "sub/test.txt"]), "exec");
    expect(second.stdout).toBe("hello\n");

    const third = expectGuestOk(
      await guest.exec(["bash", "-c", "echo second >> sub/test.txt && wc -l < sub/test.txt"]),
      "exec",
    );
    expect(third.stdout.trim()).toBe("2");
  });

  it("supports argv, env, cwd, stdin, exit codes and separate streams", async () => {
    const res = expectGuestOk(
      await guest.exec(["bash", "-c", "echo $FOO; echo err >&2; exit 7"], {
        env: { FOO: "bar" },
      }),
      "exec",
    );
    // A nonzero exit is still a successful operation; only the command failed.
    expect(res.stdout.trim()).toBe("bar");
    expect(res.stderr.trim()).toBe("err");
    expect(res.exitCode).toBe(7);

    await guest.exec(["mkdir", "-p", "workdir"]);
    const cwdRes = expectGuestOk(await guest.exec(["pwd"], { cwd: "workdir" }), "exec");
    expect(cwdRes.stdout.trim()).toMatch(/\/workspace\/workdir$/);

    const stdinRes = expectGuestOk(await guest.exec(["cat"], { stdin: "piped input" }), "exec");
    expect(stdinRes.stdout).toBe("piped input");
  });

  it("runs python3 and node", async () => {
    const py = expectGuestOk(await guest.exec(["python3", "-c", "print(1 + 1)"]), "exec");
    expect(py.stdout.trim()).toBe("2");
    const node = expectGuestOk(
      await guest.exec(["node", "-e", "console.log(process.version.startsWith('v'))"], {
        env: hostPathEnv,
      }),
      "exec",
    );
    expect(node.stdout.trim()).toBe("true");
  });

  it("rejects an unknown command cleanly", async () => {
    const res = await guest.exec(["definitely-not-a-binary"]);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("spawn_failed");
  });

  it("carries the stdout truncation flag through the wire", async () => {
    // The guest caps output at 64 KiB here. Two fields once shared the
    // `truncated` JSON tag, so encoding/json dropped both and this came back
    // undefined; the Go golden test pins the shape, this pins the boundary.
    const res = expectGuestOk(
      await guest.exec(["bash", "-c", "head -c 200000 /dev/zero | tr '\\0' x"]),
      "exec",
    );
    expect(res.truncated).toEqual({ stdout: true, stderr: false });
  });
});

describe("timeouts and cancellation", () => {
  it("enforces the per-command timeout and kills the process group", async () => {
    const res = expectGuestOk(
      await guest.exec(["bash", "-c", "sleep 30 & echo $! > bg.pid; wait"], { timeoutMs: 400 }),
      "exec",
    );
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).not.toBe(0);
    expect(res.durationMs).toBeLessThan(5000);

    // The background child must not survive the command.
    const check = expectGuestOk(
      await guest.exec(["bash", "-c", "kill -0 $(cat bg.pid) 2>/dev/null && echo alive || echo dead"]),
      "exec",
    );
    expect(check.stdout.trim()).toBe("dead");
  });

  it("cancels an in-flight command", async () => {
    const requestId = randomBytes(16).toString("hex");
    const pending = guest.op({ op: "exec", command: ["sleep", "30"], requestId });
    await sleep(500);
    await guest.relayClient.cancel(guest.sessionId, requestId);
    const result = await pending;
    expect(result.op).toBe("exec");
    if (result.op === "exec" && result.ok) {
      expect(result.cancelled).toBe(true);
      expect(result.durationMs).toBeLessThan(10_000);
    }
    // A cancelled command must not poison the session.
    const after = expectGuestOk(await guest.exec(["echo", "still-alive"]), "exec");
    expect(after.stdout.trim()).toBe("still-alive");
  }, 30_000);
});

describe("filesystem operations", () => {
  it("uploads, lists, stats and downloads files", async () => {
    const content = Buffer.from("uploaded via envelope\n");
    const put = expectGuestOk(
      await guest.op({
        op: "file.put",
        path: "incoming/hello.txt",
        dataBase64: content.toString("base64"),
      }),
      "file.put",
    );
    expect(put.bytesWritten).toBe(content.length);
    expect(put.filesWritten).toBe(1);

    const list = expectGuestOk(
      await guest.op({ op: "file.list", path: "incoming", recursive: false }),
      "file.list",
    );
    expect(list.entries.map((e) => e.path)).toContain("incoming/hello.txt");

    const stat = expectGuestOk(await guest.op({ op: "file.stat", path: "incoming/hello.txt" }), "file.stat");
    expect(stat.entry.size).toBe(content.length);
    expect(stat.entry.isDir).toBe(false);

    const get = expectGuestOk(await guest.op({ op: "file.get", path: "incoming/hello.txt" }), "file.get");
    expect(Buffer.from(get.dataBase64, "base64").toString()).toBe(content.toString());
  });

  it("round-trips a directory as an archive", async () => {
    await guest.exec(["bash", "-c", "mkdir -p tree/a && echo one > tree/a/1.txt && echo two > tree/2.txt"]);
    const get = expectGuestOk(await guest.op({ op: "file.get", path: "tree", archive: true }), "file.get");
    const archive = Buffer.from(get.dataBase64, "base64");

    expectGuestOk(
      await guest.op({
        op: "file.put",
        path: "restored",
        dataBase64: archive.toString("base64"),
        archive: true,
      }),
      "file.put",
    );
    const cat = expectGuestOk(await guest.exec(["cat", "restored/tree/a/1.txt"]), "exec");
    expect(cat.stdout.trim()).toBe("one");
  });
});

describe("workspace safety", () => {
  it("rejects path traversal", async () => {
    const res = await guest.op({ op: "file.get", path: "../../etc/passwd" });
    expect(res.ok).toBe(false);
    expect(["path_outside_workspace", "symlink_escape"]).toContain(res.error?.code);
  });

  it("rejects symlink escapes", async () => {
    await guest.exec(["bash", "-c", "ln -sfn /etc escape-link"]);
    const res = await guest.op({ op: "file.get", path: "escape-link/passwd" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("symlink_escape");

    const put = await guest.op({
      op: "file.put",
      path: "escape-link/injected",
      dataBase64: Buffer.from("x").toString("base64"),
    });
    expect(put.ok).toBe(false);
  });

  it("rejects archive path traversal and unsafe entry types", async () => {
    const traversal = makeTar([{ name: "../evil.txt", content: "pwned" }]);
    const res = await guest.op({
      op: "file.put",
      path: "uploads",
      archive: true,
      dataBase64: traversal.toString("base64"),
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("unsafe_archive");

    const symlink = makeTar([{ name: "link", content: "/etc/passwd", type: "2" }]);
    const res2 = await guest.op({
      op: "file.put",
      path: "uploads2",
      archive: true,
      dataBase64: symlink.toString("base64"),
    });
    expect(res2.ok).toBe(false);
    expect(res2.error?.code).toBe("unsafe_archive");
  });

  it("enforces the disk quota and per-file limit", async () => {
    const big = Buffer.alloc(5 * 1024 * 1024, 0x41);
    const res = await guest.op({
      op: "file.put",
      path: "big.bin",
      dataBase64: big.toString("base64"),
    });
    expect(res.ok).toBe(false);
    expect(["quota_exceeded", "file_too_large"]).toContain(res.error?.code);
  }, 30_000);
});

describe("lease enforcement", () => {
  it("terminates the supervisor when the lease ends and refuses further work", async () => {
    const short = new GuestHarness({ port: testPort(18501), leaseSeconds: 3 });
    await short.start();
    // Register the exit listener before the lease can fire.
    const exitedPromise = new Promise<boolean>((resolve) => short.proc!.once("exit", () => resolve(true)));
    try {
      const sleepResult = await short
        .op({ op: "exec", command: ["sleep", "30"], timeoutMs: 60_000 })
        .catch((err: Error) => ({ ok: false, error: { code: "relay_closed", message: err.message } }));
      // Either the command is cancelled by lease shutdown, or the relay drops.
      expect(sleepResult.ok).toBe(false);
      const exited = await Promise.race([exitedPromise, sleep(8000).then(() => false)]);
      expect(exited).toBe(true);
    } finally {
      await short.stop();
    }
  }, 40_000);
});
