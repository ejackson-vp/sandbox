/**
 * A guest that speaks the streaming transfer protocol in memory.
 *
 * `TransferService` talks to the guest through `OperationService.transfer`, so
 * the whole class can be driven from a fake that answers `transfer.init`,
 * `transfer.chunk`, `transfer.read`, `transfer.complete` and `transfer.cancel`
 * the way the guest does: it tracks a committed offset, refuses a chunk or a
 * read at the wrong offset, and echoes the digest it was told. No Postgres, no
 * guest binary, no sockets.
 *
 * The fake records every call, so a test asserts the operation sequence (which
 * operation, at which offset, with which bytes) rather than only the return
 * value. A per-call hook lets a test abort the signal, move the clock, corrupt
 * the local file or throw from the transport at an exact point in the sequence.
 */
import { createHash } from "node:crypto";
import type {
  OperationError,
  TransferInitOperation,
  TransferOperation,
  TransferResult,
} from "@x402s/shared/protocol";
import type { OperationService } from "../../sdk/src/operations.js";
import type { SessionHandle } from "../../sdk/src/types.js";

export const SESSION: SessionHandle = {
  sessionId: "sbx_transfer",
  capability: "cap",
  clientPublicKey: new Uint8Array(32),
  clientPrivateKey: new Uint8Array(32),
  clientNonce: "nonce",
  createdAt: 0,
};

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface TransferCall {
  operation: TransferOperation;
  /** The id the service passed as the transport request id. */
  requestId: string;
  timeoutMs: number;
  signal: AbortSignal | undefined;
}

/**
 * Return a result to answer the call yourself, throw to fail the transport the
 * way a dropped socket does, or return nothing to fall through to the guest.
 */
export type CallHook = (
  call: TransferCall,
  guest: FakeTransferGuest,
) => TransferResult | OperationError | void;

export class FakeTransferGuest {
  readonly calls: TransferCall[] = [];
  /** Upload chunks as the guest received them, in arrival order. */
  readonly chunks: Array<{ offset: number; data: Buffer }> = [];

  /** Uploads: bytes already stored. Downloads: the source to serve. */
  content: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  /** The offset `transfer.init` acknowledges, i.e. what a resume may skip. */
  committed = 0;
  /** The digest `transfer.init` reports. `null` means "this guest has none". */
  digest: string | null = null;
  /** How many `transfer.cancel` operations arrived. */
  cancels = 0;
  /** Size the upload declared at init. */
  declaredSize = 0;

  on?: CallHook;

  private session?: SessionHandle;

  readonly service: OperationService = {
    transfer: (
      handle: SessionHandle,
      operation: TransferOperation,
      requestId: string,
      timeoutMs: number,
      signal?: AbortSignal,
    ) => this.handle(handle, operation, requestId, timeoutMs, signal),
  } as unknown as OperationService;

  opNames(): string[] {
    return this.calls.map((call) => call.operation.op);
  }

  /** The single `transfer.init` the service issued, typed for field assertions. */
  init(): TransferInitOperation {
    const init = this.calls.find((call) => call.operation.op === "transfer.init");
    if (!init) throw new Error(`no transfer.init was issued: ${this.opNames().join(", ")}`);
    return init.operation as TransferInitOperation;
  }

  /**
   * An `ok: false` result for the call being handled, for a hook that wants the
   * guest to refuse one chunk rather than throw off the transport.
   */
  refuse(code: string, message: string): OperationError {
    const call = this.calls[this.calls.length - 1];
    if (!call) throw new Error("refuse() called before any operation was issued");
    return {
      v: 2,
      sessionId: this.session?.sessionId ?? SESSION.sessionId,
      clientNonce: this.session?.clientNonce ?? SESSION.clientNonce,
      requestId: call.requestId,
      ok: false,
      op: call.operation.op,
      error: { code, message },
    };
  }

  private async handle(
    handle: SessionHandle,
    operation: TransferOperation,
    requestId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<TransferResult | OperationError> {
    const call: TransferCall = { operation, requestId, timeoutMs, signal };
    this.session = handle;
    this.calls.push(call);
    const intercepted = this.on?.(call, this);
    if (intercepted !== undefined) return intercepted;
    return this.respond(handle, call);
  }

  /** An `ok: true` result for the call being handled, with the given fields. */
  answer(fields: Partial<TransferResult> = {}): TransferResult {
    const call = this.calls[this.calls.length - 1];
    if (!call) throw new Error("answer() called before any operation was issued");
    return this.ok(this.session ?? SESSION, call, fields);
  }

  private ok(
    handle: SessionHandle,
    call: TransferCall,
    fields: Partial<TransferResult>,
  ): TransferResult {
    const op = call.operation;
    return {
      v: 2,
      sessionId: handle.sessionId,
      clientNonce: handle.clientNonce,
      requestId: call.requestId,
      ok: true,
      op: op.op,
      transferId: op.transferId,
      direction: "upload",
      state: "TRANSFERRING",
      committedBytes: this.committed,
      size: this.declaredSize,
      ...fields,
    } as TransferResult;
  }

  private fail(handle: SessionHandle, call: TransferCall, code: string, message: string): OperationError {
    return {
      v: 2,
      sessionId: handle.sessionId,
      clientNonce: handle.clientNonce,
      requestId: call.requestId,
      ok: false,
      op: call.operation.op,
      error: { code, message },
    };
  }

  private respond(handle: SessionHandle, call: TransferCall): TransferResult | OperationError {
    const op = call.operation;
    switch (op.op) {
      case "transfer.init": {
        if (op.direction === "upload") {
          this.declaredSize = op.size ?? 0;
          return this.ok(handle, call, {
            direction: "upload",
            size: this.declaredSize,
            ...(this.digest ? { digest: this.digest } : {}),
          });
        }
        return this.ok(handle, call, {
          direction: "download",
          size: this.content.length,
          ...(this.digest ? { digest: this.digest } : {}),
        });
      }
      case "transfer.chunk": {
        const data = Buffer.from(op.dataBase64, "base64");
        if (op.offset !== this.committed) {
          return this.fail(
            handle,
            call,
            "offset_mismatch",
            `guest has ${this.committed} bytes, chunk arrived at ${op.offset}`,
          );
        }
        if (data.length === 0) {
          return this.fail(handle, call, "empty_chunk", "a transfer chunk carried no bytes");
        }
        if (this.declaredSize > 0 && op.offset + data.length > this.declaredSize) {
          return this.fail(
            handle,
            call,
            "size_mismatch",
            `chunk ends at ${op.offset + data.length}, declared size is ${this.declaredSize}`,
          );
        }
        this.chunks.push({ offset: op.offset, data });
        this.content = Buffer.concat([this.content, data]);
        this.committed += data.length;
        return this.ok(handle, call, {
          direction: "upload",
          size: this.declaredSize,
          committedBytes: this.committed,
          state: this.committed === this.declaredSize ? "VERIFYING" : "TRANSFERRING",
        });
      }
      case "transfer.complete": {
        if (op.size !== this.committed) {
          return this.fail(
            handle,
            call,
            "size_mismatch",
            `guest stored ${this.committed} bytes, complete declared ${op.size}`,
          );
        }
        if (this.digest !== null && this.digest !== op.digest) {
          return this.fail(handle, call, "integrity_failed", "upload digest does not match");
        }
        return this.ok(handle, call, {
          direction: "upload",
          size: op.size,
          state: "COMPLETED",
          committedBytes: this.committed,
          ...(this.digest ? { digest: this.digest } : {}),
        });
      }
      case "transfer.read": {
        if (op.offset !== this.committed) {
          return this.fail(
            handle,
            call,
            "offset_mismatch",
            `guest is at ${this.committed}, read asked for ${op.offset}`,
          );
        }
        const data = this.content.subarray(op.offset, op.offset + Math.max(0, op.maxBytes));
        this.committed = op.offset + data.length;
        return this.ok(handle, call, {
          direction: "download",
          size: this.content.length,
          committedBytes: this.committed,
          chunkBase64: data.toString("base64"),
        });
      }
      case "transfer.cancel": {
        this.cancels += 1;
        return this.ok(handle, call, { state: "CANCELLED", committedBytes: this.committed });
      }
      default:
        return this.fail(handle, call, "unknown_op", `the guest cannot handle ${op.op}`);
    }
  }
}
