/**
 * Encrypted guest operation and result unions. No customer plaintext lives
 * outside the sealed `envelope`; these shapes describe the decrypted payload.
 */

interface OperationBase {
  v: 2;
  sessionId: string;
  clientNonce: string;
  /** Client-generated correlation id (uuid/hex). Echoed in the response. */
  requestId: string;
}

export interface ExecOperation extends OperationBase {
  op: "exec";
  /** argv, executed without a shell. */
  command: string[];
  env?: Record<string, string>;
  /** Absolute path inside the workspace, or a path relative to it. */
  cwd?: string;
  stdin?: string;
  /** Requested timeout; the guest clamps to the lease and platform cap. */
  timeoutMs?: number;
}

export interface FilePutOperation extends OperationBase {
  op: "file.put";
  /** Workspace-relative or absolute path inside the workspace. */
  path: string;
  dataBase64: string;
  /** When true, dataBase64 is a gzipped tar archive extracted into path. */
  archive?: boolean;
  /** Octal mode, default 0644. */
  mode?: number;
}

export interface FileGetOperation extends OperationBase {
  op: "file.get";
  path: string;
  /** When true, package the path (file or directory) as a gzipped tar. */
  archive?: boolean;
}

export interface FileListOperation extends OperationBase {
  op: "file.list";
  path: string;
  recursive?: boolean;
}

export interface FileStatOperation extends OperationBase {
  op: "file.stat";
  path: string;
}

/** Start a long-running process (a local server) inside the sandbox. */

export type TransferDirection = "upload" | "download";
export type TransferState = "TRANSFERRING" | "VERIFYING" | "COMPLETED" | "CANCELLED" | "FAILED" | "EXPIRED";

export interface TransferInitOperation extends OperationBase {
  op: "transfer.init";
  transferId: string;
  direction: TransferDirection;
  path: string;
  /** Declared final size for uploads; ignored for downloads. */
  size?: number;
  chunkSize: number;
  /** Expected full-file SHA-256, where known. */
  digest?: string;
  archive?: boolean;
}

export interface TransferChunkOperation extends OperationBase {
  op: "transfer.chunk";
  transferId: string;
  offset: number;
  dataBase64: string;
}

export interface TransferCompleteOperation extends OperationBase {
  op: "transfer.complete";
  transferId: string;
  size: number;
  digest: string;
}

export interface TransferStatusOperation extends OperationBase {
  op: "transfer.status";
  transferId: string;
}

export interface TransferReadOperation extends OperationBase {
  op: "transfer.read";
  transferId: string;
  offset: number;
  maxBytes: number;
}

export interface TransferCancelOperation extends OperationBase {
  op: "transfer.cancel";
  transferId: string;
}

export interface ServiceStartOperation extends OperationBase {
  op: "service.start";
  name: string;
  command: string[];
  /** Loopback port the service is expected to listen on (1024-65535). */
  port: number;
  env?: Record<string, string>;
  cwd?: string;
}

export interface ServiceStopOperation extends OperationBase {
  op: "service.stop";
  name: string;
}

export interface ServiceListOperation extends OperationBase {
  op: "service.list";
}

/**
 * HTTP request to loopback only. The port must belong to a running service;
 * the guest never accepts a host, so this cannot reach the node or metadata.
 */
export interface HttpRequestOperation extends OperationBase {
  op: "http.request";
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
  timeoutMs?: number;
}

export interface HttpStreamOpenOperation extends OperationBase {
  op: "http.stream.open";
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
}

export interface HttpStreamReadOperation extends OperationBase {
  op: "http.stream.read";
  streamId: string;
}

export interface HttpStreamCloseOperation extends OperationBase {
  op: "http.stream.close";
  streamId: string;
}

export interface WsOpenOperation extends OperationBase {
  op: "ws.open";
  port: number;
  path: string;
  headers?: Record<string, string>;
}

export interface WsReadOperation extends OperationBase {
  op: "ws.read";
  streamId: string;
}

export interface WsSendOperation extends OperationBase {
  op: "ws.send";
  streamId: string;
  bodyBase64: string;
  binary?: boolean;
}

export interface WsCloseOperation extends OperationBase {
  op: "ws.close";
  streamId: string;
}

export interface ServiceInfo {
  name: string;
  port: number;
  pid: number;
  state: "running" | "exited" | "stopped";
  startedAt: number;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export type TransferOperation =
  | TransferInitOperation
  | TransferChunkOperation
  | TransferCompleteOperation
  | TransferStatusOperation
  | TransferReadOperation
  | TransferCancelOperation;

export type GuestRequest =
  | ExecOperation
  | FilePutOperation
  | FileGetOperation
  | FileListOperation
  | FileStatOperation
  | TransferInitOperation
  | TransferChunkOperation
  | TransferCompleteOperation
  | TransferStatusOperation
  | TransferReadOperation
  | TransferCancelOperation
  | ServiceStartOperation
  | ServiceStopOperation
  | ServiceListOperation
  | HttpRequestOperation
  | HttpStreamOpenOperation
  | HttpStreamReadOperation
  | HttpStreamCloseOperation
  | WsOpenOperation
  | WsReadOperation
  | WsSendOperation
  | WsCloseOperation;

export interface FileEntry {
  /** Workspace-relative path. */
  path: string;
  size: number;
  mode: number;
  isDir: boolean;
  mtimeMs: number;
}

interface ResultBase {
  v: 2;
  sessionId: string;
  clientNonce: string;
  requestId: string;
  /** False when the operation was rejected; see `error`. */
  ok: boolean;
  error?: { code: string; message: string };
}

export interface ExecResult extends ResultBase {
  ok: true;
  op: "exec";
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  truncated: { stdout: boolean; stderr: boolean };
}

export interface FilePutResult extends ResultBase {
  ok: true;
  op: "file.put";
  path: string;
  bytesWritten: number;
  filesWritten: number;
}

export interface FileGetResult extends ResultBase {
  ok: true;
  op: "file.get";
  path: string;
  dataBase64: string;
  size: number;
  archive: boolean;
}

export interface FileListResult extends ResultBase {
  ok: true;
  op: "file.list";
  path: string;
  entries: FileEntry[];
  totalBytes: number;
}

export interface FileStatResult extends ResultBase {
  ok: true;
  op: "file.stat";
  entry: FileEntry;
}

export interface OperationError extends ResultBase {
  ok: false;
  op: GuestRequest["op"];
}

export interface TransferResult extends ResultBase {
  ok: true;
  op:
    | "transfer.init"
    | "transfer.chunk"
    | "transfer.complete"
    | "transfer.status"
    | "transfer.read"
    | "transfer.cancel";
  transferId: string;
  direction: TransferDirection;
  state: TransferState;
  committedBytes: number;
  size: number;
  digest?: string;
  chunkBase64?: string;
  done?: boolean;
}

export interface ServiceStartResult extends ResultBase {
  ok: true;
  op: "service.start";
  service: ServiceInfo;
}

export interface ServiceListResult extends ResultBase {
  ok: true;
  op: "service.list";
  services: ServiceInfo[];
}

export interface ServiceStopResult extends ResultBase {
  ok: true;
  op: "service.stop";
  name: string;
}

export interface HttpResponseResult extends ResultBase {
  ok: true;
  op: "http.request";
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
  truncated: boolean;
}

export interface HttpStreamOpenResult extends ResultBase {
  ok: true;
  op: "http.stream.open";
  streamId: string;
  status: number;
  headers: Record<string, string>;
}

export interface HttpStreamReadResult extends ResultBase {
  ok: true;
  op: "http.stream.read";
  chunkBase64?: string;
  pending?: boolean;
  done?: boolean;
}

export interface HttpStreamCloseResult extends ResultBase {
  ok: true;
  op: "http.stream.close";
  streamId: string;
}

export interface WsOpenResult extends ResultBase {
  ok: true;
  op: "ws.open";
  streamId: string;
  status: number;
}

export interface WsReadResult extends ResultBase {
  ok: true;
  op: "ws.read";
  chunkBase64?: string;
  binary?: boolean;
  pending?: boolean;
  done?: boolean;
}

export interface WsSendResult extends ResultBase {
  ok: true;
  op: "ws.send";
  streamId: string;
}

export interface WsCloseResult extends ResultBase {
  ok: true;
  op: "ws.close";
  streamId: string;
}

export type GuestResult =
  | ExecResult
  | FilePutResult
  | FileGetResult
  | FileListResult
  | FileStatResult
  | TransferResult
  | ServiceStartResult
  | ServiceListResult
  | ServiceStopResult
  | HttpResponseResult
  | HttpStreamOpenResult
  | HttpStreamReadResult
  | HttpStreamCloseResult
  | WsOpenResult
  | WsReadResult
  | WsSendResult
  | WsCloseResult
  | OperationError;
