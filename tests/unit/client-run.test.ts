import { describe, expect, it, vi } from "vitest";
import { runOnce, type RunClient } from "../../sdk/src/run.js";
import { SandboxError, type SessionHandle } from "../../sdk/src/types.js";

const handle = {
  sessionId: "sbx_run",
  capability: "cap",
  clientPublicKey: new Uint8Array(32),
  clientPrivateKey: new Uint8Array(32),
  clientNonce: "nonce",
  createdAt: 0,
} satisfies SessionHandle;

function stubClient() {
  const calls: string[] = [];
  const mocks = {
    createSession: vi.fn(async () => {
      calls.push("create");
      return handle;
    }),
    waitForReady: vi.fn(async () => {
      calls.push("ready");
      return {};
    }),
    putFile: vi.fn(async (_handle: SessionHandle, opts: { path: string; data: Uint8Array }) => {
      calls.push(`put:${opts.path}`);
      return { ok: true as const, path: opts.path, bytesWritten: opts.data.byteLength, filesWritten: 1 };
    }),
    exec: vi.fn(async (): Promise<unknown> => {
      calls.push("exec");
      return {
        ok: true,
        exitCode: 0,
        stdout: "out",
        stderr: "",
        durationMs: 12,
        timedOut: false,
        cancelled: false,
      };
    }),
    getFile: vi.fn(async (_handle: SessionHandle, path: string) => {
      calls.push(`get:${path}`);
      return {
        ok: true as const,
        path,
        dataBase64: Buffer.from("result").toString("base64"),
        size: 6,
        archive: false,
      };
    }),
    destroy: vi.fn(async () => {
      calls.push("destroy");
      return { state: "DESTROYED" };
    }),
  };
  return { client: mocks as unknown as RunClient, calls, mocks };
}

describe("SandboxClient.run", () => {
  it("orders create, ready, upload, exec, download, destroy and returns the result", async () => {
    const { client, calls, mocks } = stubClient();

    const result = await runOnce(client, {
      command: ["sh", "-c", "cat in.txt > out.txt"],
      files: { "in.txt": "hello", "bin.dat": Uint8Array.from([1, 2]) },
      returnFiles: ["out.txt"],
      timeoutMs: 5_000,
    });

    expect(calls).toEqual([
      "create",
      "ready",
      "put:in.txt",
      "put:bin.dat",
      "exec",
      "get:out.txt",
      "destroy",
    ]);
    expect(mocks.createSession).toHaveBeenCalledWith({ runtime: "base" });
    expect(mocks.putFile).toHaveBeenNthCalledWith(1, handle, {
      path: "in.txt",
      data: Buffer.from("hello"),
    });
    expect(mocks.exec).toHaveBeenCalledWith(handle, {
      command: ["sh", "-c", "cat in.txt > out.txt"],
      timeoutMs: 5_000,
    });
    expect(mocks.getFile).toHaveBeenCalledWith(handle, "out.txt");
    expect(result).toMatchObject({
      sessionId: "sbx_run",
      exitCode: 0,
      stdout: "out",
      stderr: "",
      durationMs: 12,
      timedOut: false,
      cancelled: false,
    });
    expect(Buffer.from(result.files["out.txt"]!).toString()).toBe("result");
  });

  it("destroys the session when the command fails", async () => {
    const { client, calls, mocks } = stubClient();
    mocks.exec.mockImplementationOnce(async () => {
      calls.push("exec");
      return { ok: false, error: { code: "command_failed", message: "boom" } };
    });

    await expect(runOnce(client, { command: ["false"] })).rejects.toMatchObject({
      code: "command_failed",
    });
    expect(calls).toEqual(["create", "ready", "exec", "destroy"]);
  });

  it("destroys the session when readiness fails", async () => {
    const { client, calls, mocks } = stubClient();
    mocks.waitForReady.mockRejectedValueOnce(new Error("not ready"));

    await expect(runOnce(client, { command: ["true"] })).rejects.toThrow("not ready");
    expect(calls).toEqual(["create", "destroy"]);
  });

  it("keeps the primary error when cleanup also fails", async () => {
    const { client, mocks } = stubClient();
    const primary = new SandboxError("command_failed", "boom");
    mocks.exec.mockRejectedValueOnce(primary);
    mocks.destroy.mockRejectedValueOnce(new Error("destroy failed"));

    const error = await runOnce(client, { command: ["false"] }).catch((reason: unknown) => reason);
    expect(error).toBe(primary);
    expect(primary.cleanupError).toBeInstanceOf(Error);
    expect(primary.message).toContain("cleanup also failed");
    expect(primary.message).toContain("sbx_run");
  });

  it("surfaces a cleanup failure when the run otherwise succeeded", async () => {
    const { client, mocks } = stubClient();
    mocks.destroy.mockRejectedValueOnce(new Error("destroy failed"));

    await expect(runOnce(client, { command: ["true"] })).rejects.toThrow("destroy failed");
  });

  it("passes the selected runtime to session creation", async () => {
    const { client, calls, mocks } = stubClient();

    const result = await runOnce(client, {
      runtime: "python",
      command: ["python3", "--version"],
    });

    expect(result.exitCode).toBe(0);
    expect(mocks.createSession).toHaveBeenCalledWith({ runtime: "python" });
    expect(calls).toEqual(["create", "ready", "exec", "destroy"]);
  });

  it("rejects an unsupported runtime before creating a session", async () => {
    const { client, calls, mocks } = stubClient();

    await expect(
      runOnce(client, { runtime: "cobol", command: ["true"] }),
    ).rejects.toMatchObject({
      code: "unsupported_runtime",
      message: expect.stringContaining("base, python, node"),
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});
