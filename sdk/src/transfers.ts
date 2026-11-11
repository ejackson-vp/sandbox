/**
 * Bounded-memory, resumable file transfers. Each chunk is a separate sealed
 * operation; the guest acknowledges committed offsets in order. One chunk is
 * in flight at a time, which provides backpressure through the existing
 * request/response transport without adding a second data plane.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  TransferOperation,
  TransferResult,
  OperationError,
} from "@x402s/shared/protocol";
import type { OperationService } from "./operations.js";
import { SandboxError, type SessionHandle } from "./types.js";

export const DEFAULT_CHUNK_SIZE = 512 * 1024;
const MIN_CHUNK = 64 * 1024;
const MAX_CHUNK = 1024 * 1024;

export interface TransferProgress {
  transferId: string;
  direction: "upload" | "download";
  bytesTransferred: number;
  totalBytes: number;
}

export interface TransferOptions {
  /** Transfer a directory as a safe tar.gz archive. */
  archive?: boolean;
  /** Use an existing transfer id to resume after a transport failure. */
  transferId?: string;
  chunkSize?: number;
  /** Whole-transfer deadline. Individual chunks use a bounded slice. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: TransferProgress) => void;
}

export interface TransferOutcome {
  transferId: string;
  bytesTransferred: number;
  digest: string;
}

export class TransferError extends SandboxError {
  constructor(
    code: string,
    message: string,
    readonly transferId?: string,
    status?: number,
  ) {
    super(code, message, status);
    this.name = "TransferError";
  }
}

function chunkSizeOf(value?: number): number {
  const n = value ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isInteger(n) || n < MIN_CHUNK || n > MAX_CHUNK) {
    throw new TransferError("invalid_chunk_size", `chunkSize must be between ${MIN_CHUNK} and ${MAX_CHUNK} bytes`);
  }
  return n;
}

function requestId(): string {
  return randomBytes(16).toString("hex");
}

function check(result: TransferResult | OperationError, transferId: string): TransferResult {
  if (!result.ok) {
    throw new TransferError(result.error?.code ?? "transfer_failed", result.error?.message ?? "transfer failed", transferId);
  }
  return result;
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function assertAlive(signal: AbortSignal | undefined, deadline: number, transferId: string): void {
  if (signal?.aborted) throw new TransferError("transfer_cancelled", "transfer was cancelled", transferId);
  if (Date.now() > deadline) throw new TransferError("transfer_timeout", "transfer deadline exceeded", transferId);
}

export class TransferService {
  constructor(
    private readonly operations: OperationService,
  ) {}

  private async op(
    handle: SessionHandle,
    operation: TransferOperation,
    transferId: string,
    signal: AbortSignal | undefined,
  ): Promise<TransferResult> {
    const id = requestId();
    const prepared = { ...operation, requestId: id } as TransferOperation;
    const result = await this.operations.transfer(handle, prepared, id, 60_000, signal);
    return check(result, transferId);
  }

  async upload(
    handle: SessionHandle,
    localPath: string,
    remotePath: string,
    opts: TransferOptions = {},
  ): Promise<TransferOutcome> {
    const chunkSize = chunkSizeOf(opts.chunkSize);
    const transferId = opts.transferId ?? randomBytes(16).toString("hex");
    const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
    const info = await stat(localPath);
    if (!info.isFile()) throw new TransferError("not_a_file", "local path is not a regular file", transferId);
    const digest = await fileDigest(localPath);
    const emit = (bytes: number) => opts.onProgress?.({
      transferId,
      direction: "upload",
      bytesTransferred: bytes,
      totalBytes: info.size,
    });

    let committed = 0;
    try {
      const init = await this.op(handle, {
        v: 2,
        sessionId: handle.sessionId,
        clientNonce: handle.clientNonce,
        requestId: requestId(),
        op: "transfer.init",
        transferId,
        direction: "upload",
        path: remotePath,
        size: info.size,
        chunkSize,
        archive: Boolean(opts.archive),
      }, transferId, opts.signal);
      committed = init.committedBytes;
      emit(committed);
      const file = await open(localPath, "r");
      try {
        const buffer = Buffer.allocUnsafe(chunkSize);
        while (committed < info.size) {
          assertAlive(opts.signal, deadline, transferId);
          const remaining = info.size - committed;
          const length = Math.min(buffer.byteLength, remaining);
          const read = await file.read(buffer, 0, length, committed);
          if (read.bytesRead === 0) throw new TransferError("short_read", "local file ended before its declared size", transferId);
          const chunk = buffer.subarray(0, read.bytesRead);
          const ack = await this.op(handle, {
            v: 2,
            sessionId: handle.sessionId,
            clientNonce: handle.clientNonce,
            requestId: requestId(),
            op: "transfer.chunk",
            transferId,
            offset: committed,
            dataBase64: chunk.toString("base64"),
          }, transferId, opts.signal);
          committed = ack.committedBytes;
          emit(committed);
        }
      } finally {
        await file.close();
      }
      const done = await this.op(handle, {
        v: 2,
        sessionId: handle.sessionId,
        clientNonce: handle.clientNonce,
        requestId: requestId(),
        op: "transfer.complete",
        transferId,
        size: info.size,
        digest,
      }, transferId, opts.signal);
      return { transferId, bytesTransferred: done.committedBytes, digest: done.digest ?? digest };
    } catch (err) {
      if (opts.signal?.aborted) {
        await this.op(handle, {
          v: 2, sessionId: handle.sessionId, clientNonce: handle.clientNonce, requestId: requestId(),
          op: "transfer.cancel", transferId,
        }, transferId, undefined).catch(() => undefined);
      }
      if (err instanceof TransferError) throw err;
      throw new TransferError("transfer_failed", (err as Error).message, transferId);
    }
  }

  async download(
    handle: SessionHandle,
    remotePath: string,
    localPath: string,
    opts: TransferOptions = {},
  ): Promise<TransferOutcome> {
    const chunkSize = chunkSizeOf(opts.chunkSize);
    const transferId = opts.transferId ?? randomBytes(16).toString("hex");
    const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
    const part = `${localPath}.x402-part-${transferId}`;
    await mkdir(dirname(localPath), { recursive: true });
    let committed = 0;
    let total = 0;
    let expectedDigest = "";
    let stage = "init";
    const emit = () => opts.onProgress?.({
      transferId,
      direction: "download",
      bytesTransferred: committed,
      totalBytes: total,
    });

    try {
      const init = await this.op(handle, {
        v: 2,
        sessionId: handle.sessionId,
        clientNonce: handle.clientNonce,
        requestId: requestId(),
        op: "transfer.init",
        transferId,
        direction: "download",
        path: remotePath,
        chunkSize,
        archive: Boolean(opts.archive),
      }, transferId, opts.signal);
      total = init.size;
      expectedDigest = init.digest ?? "";
      const partSize = opts.transferId ? (await stat(part).catch(() => ({ size: 0 }))).size : 0;
      if (opts.transferId && partSize !== init.committedBytes) {
        throw new TransferError(
          "resume_mismatch",
          `local partial size ${partSize} does not match acknowledged offset ${init.committedBytes}`,
          transferId,
        );
      }
      committed = init.committedBytes;
      emit();
      const file = await open(part, committed > 0 ? "r+" : "w");
      try {
        while (committed < total) {
          assertAlive(opts.signal, deadline, transferId);
          stage = "read";
          const result = await this.op(handle, {
            v: 2,
            sessionId: handle.sessionId,
            clientNonce: handle.clientNonce,
            requestId: requestId(),
            op: "transfer.read",
            transferId,
            offset: committed,
            maxBytes: Math.min(chunkSize, total - committed),
          }, transferId, opts.signal);
          if (!result.chunkBase64) throw new TransferError("missing_chunk", "guest returned no download chunk", transferId);
          const data = Buffer.from(result.chunkBase64, "base64");
          await file.write(data, 0, data.length, committed);
          committed += data.length;
          emit();
        }
      } finally {
        await file.close();
      }
      const actual = await fileDigest(part);
      if (expectedDigest && actual !== expectedDigest) {
        throw new TransferError("integrity_failed", "downloaded file SHA-256 does not match the source", transferId);
      }
      await rename(part, localPath);
      return { transferId, bytesTransferred: committed, digest: actual };
    } catch (err) {
      if (opts.signal?.aborted) {
        await this.op(handle, {
          v: 2, sessionId: handle.sessionId, clientNonce: handle.clientNonce, requestId: requestId(),
          op: "transfer.cancel", transferId,
        }, transferId, undefined).catch(() => undefined);
        await rm(part, { force: true }).catch(() => undefined);
      }
      if (err instanceof TransferError) throw err;
      throw new TransferError("transfer_failed", `${stage}: ${(err as Error).message}`, transferId);
    }
  }
}
