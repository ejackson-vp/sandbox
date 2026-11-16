/**
 * Directory transfers in the `Sandbox` facade.
 *
 * Two of these behaviours are the whole reason the facade exists: a directory is
 * archived before it is uploaded, and an archive that comes back is listed and
 * checked before anything is written to the local filesystem. The second one is
 * a path-traversal guard: a member named `../x` or an absolute path must stop
 * the download rather than escape the destination.
 *
 * The client is stubbed at the transfer seam, and the archives are real tarballs
 * written by a tiny POSIX-tar helper here, so the guard is exercised by the same
 * `tar` binary the SDK shells out to.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { Sandbox } from "../../sdk/src/sandbox.js";
import type { SandboxClient } from "../../sdk/src/client.js";
import type { SessionHandle } from "../../sdk/src/types.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "x402-dir-transfer-"));
  dirs.push(dir);
  return dir;
}

const handle: SessionHandle = {
  sessionId: "sbx_test",
  capability: "cap",
  clientPublicKey: new Uint8Array(32),
  clientPrivateKey: new Uint8Array(32),
  clientNonce: "nonce",
  createdAt: 0,
};

interface Member {
  name: string;
  data?: string;
}

/** A gzipped POSIX tar with the given members, built here so it is portable. */
function tarGz(members: Member[]): Buffer {
  const blocks: Buffer[] = [];
  for (const member of members) {
    const data = Buffer.from(member.data ?? "");
    const header = Buffer.alloc(512, 0);
    header.write(member.name, 0, 100, "utf8");
    header.write(member.data === undefined ? "0000755\0" : "0000644\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    header.write("00000000000\0", 136, "ascii");
    header.write("        ", 148, "ascii");
    header.write(member.data === undefined ? "5" : "0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

interface Harness {
  sandbox: Sandbox;
  uploads: Array<{ localPath: string; remotePath: string; opts?: Record<string, unknown> }>;
  puts: Array<{ path: string; data: Uint8Array }>;
}

function harness(opts: { downloadTo?: (localPath: string) => void; maxFileBytes?: number } = {}): Harness {
  const uploads: Harness["uploads"] = [];
  const puts: Harness["puts"] = [];
  const client = {
    async uploadFile(_handle: SessionHandle, localPath: string, remotePath: string, transferOpts?: Record<string, unknown>) {
      uploads.push({ localPath, remotePath, opts: transferOpts });
      return { transferId: "transfer-1", bytesTransferred: 10, digest: "sha256:test" };
    },
    async putFile(_handle: SessionHandle, putOpts: { path: string; data: Uint8Array }) {
      puts.push(putOpts);
      return { ok: true as const, path: putOpts.path, bytesWritten: putOpts.data.byteLength, filesWritten: 1 };
    },
    async downloadFile(_handle: SessionHandle, _remotePath: string, localPath: string) {
      opts.downloadTo?.(localPath);
      return { transferId: "transfer-2", bytesTransferred: 20, digest: "sha256:down" };
    },
  } as unknown as SandboxClient;
  const sized = { ...handle, status: { limits: { maxFileBytes: opts.maxFileBytes ?? 1024 } } } as unknown as SessionHandle;
  return { sandbox: new Sandbox(client, sized), uploads, puts };
}

describe("upload", () => {
  it("archives a directory and cleans up the tarball it made", async () => {
    const dir = tempDir();
    const workspace = join(dir, "workspace");
    mkdirSync(join(workspace, "sub"), { recursive: true });
    writeFileSync(join(workspace, "a.txt"), "hello");
    writeFileSync(join(workspace, "sub", "b.txt"), "world");

    const h = harness();
    const outcome = await h.sandbox.upload(workspace, "/workspace/app");

    expect(outcome).toMatchObject({ transferId: "transfer-1" });
    expect(h.uploads).toHaveLength(1);
    expect(h.uploads[0]!.opts).toMatchObject({ archive: true });
    expect(h.uploads[0]!.localPath.endsWith("payload.tar.gz")).toBe(true);
    // The temp directory is removed even though the transfer succeeded.
    expect(() => statSync(join(h.uploads[0]!.localPath))).toThrow();
    expect(h.puts).toHaveLength(0);
  });

  it("uploads a file that is too big for file.put as a transfer", async () => {
    const dir = tempDir();
    const large = join(dir, "large.bin");
    writeFileSync(large, Buffer.alloc(64));

    const h = harness({ maxFileBytes: 16 });
    await h.sandbox.upload(large, "/workspace/large.bin");

    expect(h.puts).toHaveLength(0);
    expect(h.uploads[0]).toMatchObject({ localPath: large, remotePath: "/workspace/large.bin" });
  });

  it("uploads a small file inline when there is no transfer id", async () => {
    const dir = tempDir();
    const small = join(dir, "small.txt");
    writeFileSync(small, "hi");

    const h = harness({ maxFileBytes: 1024 });
    const outcome = await h.sandbox.upload(small, "/workspace/small.txt");

    expect(outcome).toMatchObject({ ok: true, filesWritten: 1 });
    expect(h.puts[0]).toMatchObject({ path: "/workspace/small.txt" });
    expect(Buffer.from(h.puts[0]!.data).toString()).toBe("hi");
    expect(h.uploads).toHaveLength(0);
  });

  it("uses the transfer path when the caller asked for one", async () => {
    const dir = tempDir();
    const small = join(dir, "small.txt");
    writeFileSync(small, "hi");

    const h = harness();
    await h.sandbox.upload(small, "/workspace/small.txt", { transferId: "t-1" });
    expect(h.uploads).toHaveLength(1);
    expect(h.puts).toHaveLength(0);
  });
});

describe("download", () => {
  it("extracts a safe archive into the destination", async () => {
    const dir = tempDir();
    const destination = join(dir, "out");
    const archive = tarGz([
      { name: "out/", data: undefined },
      { name: "out/ok.txt", data: "contents" },
    ]);

    const h = harness({ downloadTo: (localPath) => writeFileSync(localPath, archive) });
    await h.sandbox.download("/workspace/app", destination, { archive: true });

    expect(readFileSync(join(destination, "out", "ok.txt"), "utf8")).toBe("contents");
  });

  it("refuses an archive member that would escape the destination", async () => {
    const dir = tempDir();
    const destination = join(dir, "out");
    const escape = join(dir, "escaped.txt");
    const archive = tarGz([{ name: "../escaped.txt", data: "pwned" }]);

    const h = harness({ downloadTo: (localPath) => writeFileSync(localPath, archive) });
    await expect(h.sandbox.download("/workspace/app", destination, { archive: true })).rejects.toThrow(
      /unsafe archive member/,
    );
    // Nothing was written, inside the destination or beside it.
    expect(() => statSync(escape)).toThrow();
  });

  it("refuses an absolute member path", async () => {
    const dir = tempDir();
    const destination = join(dir, "out");
    const archive = tarGz([{ name: "/etc/x402-escaped", data: "pwned" }]);

    const h = harness({ downloadTo: (localPath) => writeFileSync(localPath, archive) });
    await expect(h.sandbox.download("/workspace/app", destination, { archive: true })).rejects.toThrow(
      /unsafe archive member/,
    );
  });

  it("passes a plain download straight through", async () => {
    const dir = tempDir();
    const local = join(dir, "file.txt");
    const h = harness({ downloadTo: (localPath) => writeFileSync(localPath, "payload") });
    const outcome = await h.sandbox.download("/workspace/file.txt", local);
    expect(outcome).toMatchObject({ transferId: "transfer-2" });
    expect(readFileSync(local, "utf8")).toBe("payload");
  });
});

describe("delegation", () => {
  it("exposes the session id under both names", () => {
    const h = harness();
    expect(h.sandbox.sessionId).toBe(handle.sessionId);
    expect(h.sandbox.id).toBe(handle.sessionId);
  });

  it("hands the handle to the status calls and the timeout to resume", async () => {
    const seen: string[] = [];
    const client = {
      status: async () => (seen.push("status"), { state: "READY" }),
      suspend: async () => (seen.push("suspend"), { state: "SUSPENDED" }),
      resume: async (_handle: SessionHandle, timeoutMs?: number) => {
        seen.push(`resume:${timeoutMs}`);
        return { state: "RESUMING" };
      },
      http: async (_handle: SessionHandle, opts: { port: number }) => {
        seen.push(`http:${opts.port}`);
        return { status: 200, headers: {}, body: Buffer.alloc(0), truncated: false };
      },
    } as unknown as SandboxClient;
    const sandbox = new Sandbox(client, handle);

    expect(await sandbox.status()).toMatchObject({ state: "READY" });
    expect(await sandbox.suspend()).toMatchObject({ state: "SUSPENDED" });
    expect(await sandbox.resume(1_234)).toMatchObject({ state: "RESUMING" });
    expect((await sandbox.http({ port: 8080 })).status).toBe(200);
    expect(seen).toEqual(["status", "suspend", "resume:1234", "http:8080"]);
  });
});
