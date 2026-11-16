/**
 * Operation envelopes and the one refusal the client makes on its own.
 *
 * `file.put` is the only operation the client refuses before it leaves, and it
 * refuses on the session's own byte limit. A client that only *tried* would have
 * the guest reject it after the bytes crossed the relay, and the limit is the
 * one thing standing between a workspace and a full disk. The rest of the file
 * pins the envelope fields the guest routes on, because a misnamed `op` or a
 * missing `archive` flag is not visible from the caller's side.
 */
import { describe, expect, it } from "vitest";
import { OperationService } from "../../sdk/src/operations.js";
import type { ClientRuntime } from "../../sdk/src/runtime.js";
import { SandboxError, type SessionHandle } from "../../sdk/src/types.js";

function handle(maxFileBytes?: number): SessionHandle {
  return {
    sessionId: "sbx_operations",
    capability: "cap",
    clientPublicKey: new Uint8Array(32),
    clientPrivateKey: new Uint8Array(32),
    clientNonce: "nonce",
    createdAt: 0,
    ...(maxFileBytes === undefined
      ? {}
      : { status: { limits: { maxFileBytes } } as unknown as SessionHandle["status"] }),
  };
}

interface Sent {
  operation: Record<string, unknown>;
  requestId: string;
  timeoutMs?: number;
}

function service(answer: Record<string, unknown> = { ok: true }): { operations: OperationService; sent: Sent[] } {
  const sent: Sent[] = [];
  const rt = {
    async run(_handle: SessionHandle, operation: { requestId: string }, requestId: string, _queueMs: number, timeoutMs?: number) {
      sent.push({ operation: operation as unknown as Record<string, unknown>, requestId, timeoutMs });
      return answer;
    },
    async runGet(_handle: SessionHandle, operation: { requestId: string }, requestId: string) {
      sent.push({ operation: operation as unknown as Record<string, unknown>, requestId });
      return answer;
    },
    async api(_path: string) {
      return new Response(null, { status: 202 });
    },
  } as unknown as ClientRuntime;
  return { operations: new OperationService(rt), sent };
}

describe("putFile", () => {
  it("refuses an upload over the session limit without sending it", async () => {
    const { operations, sent } = service();
    const error = await operations
      .putFile(handle(8), { path: "/workspace/big.bin", data: new Uint8Array(9) })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SandboxError);
    expect(error).toMatchObject({ code: "file_too_large" });
    expect((error as SandboxError).message).toContain("8 bytes");
    expect(sent).toHaveLength(0);
  });

  it("sends a file at exactly the limit, base64-encoded, with the archive flag", async () => {
    const { operations, sent } = service();
    await operations.putFile(handle(8), {
      path: "/workspace/ok.bin",
      data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      archive: true,
      mode: 0o644,
    });

    expect(sent[0]!.operation).toMatchObject({
      op: "file.put",
      path: "/workspace/ok.bin",
      dataBase64: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).toString("base64"),
      archive: true,
      mode: 0o644,
    });
    expect(sent[0]!.timeoutMs).toBe(30_000);
  });

  it("defaults the limit to 8 MiB when the session has no status yet", async () => {
    const { operations } = service();
    await expect(
      operations.putFile(handle(), { path: "/workspace/big.bin", data: new Uint8Array(8 * 1024 * 1024 + 1) }),
    ).rejects.toMatchObject({ code: "file_too_large" });
  });
});

describe("the read envelopes", () => {
  it("asks for a file as a `file.get` on the GET surface", async () => {
    const { operations, sent } = service({ ok: true, path: "/workspace/x", size: 1 });
    await operations.getFile(handle(1024), "/workspace/x");
    expect(sent[0]!.operation).toMatchObject({ op: "file.get", path: "/workspace/x" });
    expect(sent[0]!.operation).not.toHaveProperty("archive");
  });

  it("marks a listing as recursive only when asked", async () => {
    const { operations, sent } = service({ ok: true, entries: [] });
    await operations.listFiles(handle(), "/workspace", true);
    await operations.listFiles(handle());
    expect(sent[0]!.operation).toMatchObject({ op: "file.list", path: "/workspace", recursive: true });
    expect(sent[1]!.operation).toMatchObject({ op: "file.list", path: ".", recursive: false });
  });

  it("asks for stat by path", async () => {
    const { operations, sent } = service({ ok: true, size: 1 });
    await operations.statFile(handle(), "/workspace/x");
    expect(sent[0]!.operation).toMatchObject({ op: "file.stat", path: "/workspace/x" });
  });
});

describe("exec", () => {
  it("carries the command, env, cwd and stdin the caller asked for", async () => {
    const { operations, sent } = service({ ok: true, exitCode: 0 });
    await operations.exec(handle(), {
      command: ["sh", "-c", "cat"],
      env: { A: "1" },
      cwd: "/workspace",
      stdin: "input",
      timeoutMs: 1_000,
      requestId: "req-fixed",
    });

    expect(sent[0]!.operation).toMatchObject({
      op: "exec",
      command: ["sh", "-c", "cat"],
      env: { A: "1" },
      cwd: "/workspace",
      stdin: "input",
      timeoutMs: 1_000,
    });
    expect(sent[0]!.requestId).toBe("req-fixed");
  });

  it("generates a request id when the caller does not pin one", async () => {
    const { operations, sent } = service({ ok: true, exitCode: 0 });
    await operations.exec(handle(), { command: ["true"] });
    expect(sent[0]!.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(sent[0]!.operation.requestId).toBe(sent[0]!.requestId);
  });
});
