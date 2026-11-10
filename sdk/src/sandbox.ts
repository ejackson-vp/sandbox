/**
 * Ergonomic single-sandbox facade over the handle-based client. This is the
 * recommended entry point for application code; the lower-level methods remain
 * available for tools that need to attach to an existing handle.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  ExecOptions,
  FilePutOptions,
  HttpOptions,
  HttpResponse,
  SessionHandle,
} from "./types.js";
import type { ExecResult, FilePutResult, OperationError, SessionStatus } from "@x402s/shared";
import type { TransferOptions, TransferOutcome } from "./transfers.js";

const exec = promisify(execFile);

async function archiveDirectory(path: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "x402-sdk-archive-"));
  const archive = join(dir, "payload.tar.gz");
  await exec("tar", ["-czf", archive, "-C", resolve(path), "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  return archive;
}

async function extractArchive(archive: string, destination: string): Promise<void> {
  const { stdout } = await exec("tar", ["-tzf", archive]);
  for (const member of stdout.split("\n").filter(Boolean)) {
    if (member.startsWith("/") || member.split("/").includes("..")) {
      throw new Error(`unsafe archive member: ${member}`);
    }
  }
  await exec("mkdir", ["-p", destination]);
  await exec("tar", ["-xzf", archive, "-C", destination, "--no-same-owner"]);
}

/**
 * What the facade needs from the client, declared here in the consumer rather
 * than imported from client.ts. client.ts constructs `Sandbox`, so importing
 * its type from here closed a module cycle. `SandboxClient` satisfies this
 * structurally, which the `new Sandbox(client, handle)` call site checks.
 */
interface SandboxOperations {
  destroy(handle: SessionHandle, waitMs?: number): Promise<SessionStatus | null>;
  downloadFile(
    handle: SessionHandle,
    remotePath: string,
    localPath: string,
    opts?: TransferOptions,
  ): Promise<TransferOutcome>;
  exec(handle: SessionHandle, opts: ExecOptions): Promise<ExecResult | OperationError>;
  http(handle: SessionHandle, opts: HttpOptions): Promise<HttpResponse>;
  putFile(handle: SessionHandle, opts: FilePutOptions): Promise<FilePutResult | OperationError>;
  resume(handle: SessionHandle, timeoutMs?: number): Promise<SessionStatus>;
  status(handle: SessionHandle): Promise<SessionStatus>;
  suspend(handle: SessionHandle): Promise<SessionStatus>;
  uploadFile(
    handle: SessionHandle,
    localPath: string,
    remotePath: string,
    opts?: TransferOptions,
  ): Promise<TransferOutcome>;
}

export class Sandbox {
  constructor(
    private readonly client: SandboxOperations,
    readonly handle: SessionHandle,
  ) {}

  get sessionId(): string {
    return this.handle.sessionId;
  }

  get id(): string {
    return this.handle.sessionId;
  }

  exec(opts: ExecOptions) {
    return this.client.exec(this.handle, opts);
  }

  async upload(
    localPath: string,
    remotePath: string,
    opts: TransferOptions = {},
  ): Promise<FilePutResult | TransferOutcome | OperationError> {
    const maxFileBytes = this.handle.status?.limits.maxFileBytes ?? 8 * 1024 * 1024;
    const info = await stat(localPath);
    if (info.isDirectory()) {
      const archive = await archiveDirectory(localPath);
      try {
        return await this.client.uploadFile(this.handle, archive, remotePath, { ...opts, archive: true });
      } finally {
        await rm(dirname(archive), { recursive: true, force: true });
      }
    }
    if (opts.transferId || info.size > maxFileBytes) {
      return this.client.uploadFile(this.handle, localPath, remotePath, opts);
    }
    return this.client.putFile(this.handle, { path: remotePath, data: await readFile(localPath) });
  }

  async download(remotePath: string, localPath: string, opts: TransferOptions = {}): Promise<TransferOutcome> {
    if (opts.archive) {
      const dir = await mkdtemp(join(tmpdir(), "x402-sdk-download-"));
      const archive = join(dir, "payload.tar.gz");
      try {
        const outcome = await this.client.downloadFile(this.handle, remotePath, archive, { ...opts, archive: true });
        await extractArchive(archive, localPath);
        return outcome;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    return this.client.downloadFile(this.handle, remotePath, localPath, opts);
  }

  http(opts: HttpOptions): Promise<HttpResponse> {
    return this.client.http(this.handle, opts);
  }

  status(): Promise<SessionStatus> {
    return this.client.status(this.handle);
  }

  suspend(): Promise<SessionStatus> {
    return this.client.suspend(this.handle);
  }

  resume(timeoutMs = 180_000): Promise<SessionStatus> {
    return this.client.resume(this.handle, timeoutMs);
  }

  destroy(waitMs = 30_000): Promise<SessionStatus | null> {
    return this.client.destroy(this.handle, waitMs);
  }
}
