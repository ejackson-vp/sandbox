/**
 * Ergonomic single-sandbox facade over the handle-based client. This is the
 * recommended entry point for application code; the lower-level methods remain
 * available for tools that need to attach to an existing handle.
 */
import { readFile, writeFile } from "node:fs/promises";
import type { SandboxClient } from "./client.js";
import type { ExecOptions, FileOutcome, HttpOptions, HttpResponse, SessionHandle } from "./types.js";
import type { SessionStatus } from "@x402s/shared";
import type { FileGetResult, FilePutResult, OperationError } from "@x402s/shared";

export class Sandbox {
  constructor(
    private readonly client: SandboxClient,
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

  async upload(localPath: string, remotePath: string): Promise<FilePutResult | OperationError> {
    return this.client.putFile(this.handle, { path: remotePath, data: await readFile(localPath) });
  }

  async download(remotePath: string, localPath: string): Promise<FileOutcome<FileGetResult>> {
    const result = await this.client.getFile(this.handle, remotePath);
    if (result.ok) await writeFile(localPath, Buffer.from(result.dataBase64, "base64"));
    return result;
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
