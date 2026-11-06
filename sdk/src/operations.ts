/**
 * Encrypted command and filesystem operations.
 */
import { randomBytes } from "node:crypto";
import type {
  ExecOperation,
  ExecResult,
  FileGetOperation,
  FileGetResult,
  FileListOperation,
  FileListResult,
  FilePutOperation,
  FilePutResult,
  FileStatOperation,
  FileStatResult,
  GuestResult,
  OperationError,
} from "@x402s/shared";
import type { ClientRuntime } from "./runtime.js";
import type { ExecOptions, FilePutOptions, SessionHandle } from "./types.js";

export class OperationService {
  constructor(private readonly rt: ClientRuntime) {}

  async exec(handle: SessionHandle, opts: ExecOptions): Promise<ExecResult | OperationError> {
    const requestId = opts.requestId ?? randomBytes(16).toString("hex");
    const operation: ExecOperation = {
      v: 2,
      sessionId: handle.sessionId,
      clientNonce: handle.clientNonce,
      requestId,
      op: "exec",
      command: opts.command,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.stdin ? { stdin: opts.stdin } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    };
    return this.rt.run<ExecResult>(handle, operation, requestId, opts.queueMs, opts.timeoutMs, opts.signal);
  }

  async putFile(handle: SessionHandle, opts: FilePutOptions): Promise<FilePutResult | OperationError> {
    const requestId = opts.requestId ?? randomBytes(16).toString("hex");
    const operation: FilePutOperation = {
      v: 2,
      sessionId: handle.sessionId,
      clientNonce: handle.clientNonce,
      requestId,
      op: "file.put",
      path: opts.path,
      dataBase64: Buffer.from(opts.data).toString("base64"),
      ...(opts.archive ? { archive: true } : {}),
      ...(opts.mode ? { mode: opts.mode } : {}),
    };
    return this.rt.run<FilePutResult>(handle, operation, requestId, opts.queueMs, 30_000);
  }

  async getFile(
    handle: SessionHandle,
    path: string,
    archive = false,
    queueMs = 0,
  ): Promise<FileGetResult | OperationError> {
    const requestId = randomBytes(16).toString("hex");
    const operation: FileGetOperation = {
      v: 2,
      sessionId: handle.sessionId,
      clientNonce: handle.clientNonce,
      requestId,
      op: "file.get",
      path,
      ...(archive ? { archive: true } : {}),
    };
    return this.rt.runGet<FileGetResult>(handle, operation, requestId, queueMs);
  }

  async listFiles(handle: SessionHandle, path = ".", recursive = false): Promise<FileListResult | OperationError> {
    const requestId = randomBytes(16).toString("hex");
    const operation: FileListOperation = {
      v: 2,
      sessionId: handle.sessionId,
      clientNonce: handle.clientNonce,
      requestId,
      op: "file.list",
      path,
      recursive,
    };
    return this.rt.runGet<FileListResult>(handle, operation, requestId, 0);
  }

  async statFile(handle: SessionHandle, path: string): Promise<FileStatResult | OperationError> {
    const requestId = randomBytes(16).toString("hex");
    const operation: FileStatOperation = {
      v: 2,
      sessionId: handle.sessionId,
      clientNonce: handle.clientNonce,
      requestId,
      op: "file.stat",
      path,
    };
    return this.rt.runGet<FileStatResult>(handle, operation, requestId, 0);
  }

  async cancel(handle: SessionHandle, requestId: string): Promise<void> {
    await this.rt.api(`/v1/sessions/${handle.sessionId}/requests/${requestId}`, {
      method: "DELETE",
      headers: this.rt.auth(handle),
    });
  }

  getOperation(handle: SessionHandle, requestId: string, waitMs = 20_000): Promise<GuestResult | null> {
    return this.rt.getOperation(handle, requestId, waitMs);
  }
}
