import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox } from "../../sdk/src/sandbox.js";
import type { SandboxClient } from "../../sdk/src/client.js";
import type { SessionHandle } from "../../sdk/src/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "x402-sdk-"));
  dirs.push(dir);
  return dir;
}

const handle = {
  sessionId: "sbx_test",
  capability: "cap",
  clientPublicKey: new Uint8Array(32),
  clientPrivateKey: new Uint8Array(32),
  clientNonce: "nonce",
  createdAt: 0,
} satisfies SessionHandle;

describe("Sandbox facade", () => {
  it("uploads, downloads, executes and destroys through the public methods", async () => {
    const dir = tempDir();
    const local = join(dir, "in.txt");
    const remote = join(dir, "out.txt");
    writeFileSync(local, "hello");

    const client = {
      putFile: vi.fn(async (_handle, opts) => ({ ok: true, filesWritten: 1, path: opts.path })),
      downloadFile: vi.fn(async (_handle, _remote, local) => {
        writeFileSync(local, "result");
        return { transferId: "transfer-1", bytesTransferred: 6, digest: "digest" };
      }),
      exec: vi.fn(async () => ({ ok: true, stdout: "ok", stderr: "", exitCode: 0 })),
      destroy: vi.fn(async () => ({ state: "DESTROYED" })),
    } as unknown as SandboxClient;

    const sandbox = new Sandbox(client, handle);
    expect(sandbox.id).toBe("sbx_test");
    // A small file goes through putFile; the transfer arm of the union has no
    // `ok`, so assert on the shape instead of a property only one arm has.
    expect(await sandbox.upload(local, "/workspace/out.txt")).toMatchObject({ ok: true, filesWritten: 1 });
    expect(client.putFile).toHaveBeenCalledWith(handle, {
      path: "/workspace/out.txt",
      data: Buffer.from("hello"),
    });
    expect((await sandbox.exec({ command: ["echo", "ok"] })).ok).toBe(true);
    expect((await sandbox.download("/workspace/out.txt", remote)).transferId).toBe("transfer-1");
    expect(readFileSync(remote, "utf8")).toBe("result");
    await sandbox.destroy();
    expect(client.destroy).toHaveBeenCalledWith(handle, 30_000);
  });
});
