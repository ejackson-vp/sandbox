/**
 * Public SDK facade. Composes the runtime, session, operations and data-plane
 * modules; the exported method surface is unchanged.
 */
import type { GuestResult, SessionStatus } from "@x402s/shared";
import { ClientRuntime } from "./runtime.js";
import { SessionService } from "./session.js";
import { OperationService } from "./operations.js";
import { DataPlane } from "./data-plane.js";
import { Sandbox } from "./sandbox.js";
import { TransferService, type TransferOptions, type TransferOutcome } from "./transfers.js";
import type { StoredSession } from "./session-store.js";
import type {
  CreateOptions,
  ExecOptions,
  FilePutOptions,
  HttpOptions,
  HttpResponse,
  HttpStream,
  OpenHttpStreamOptions,
  OpenWebSocketOptions,
  SandboxClientOptions,
  SessionHandle,
  StartServiceOptions,
  WebSocketStream,
} from "./types.js";

export class SandboxClient {
  private readonly rt: ClientRuntime;
  private readonly sessions: SessionService;
  private readonly operations: OperationService;
  private readonly dataPlane: DataPlane;
  private readonly transfers: TransferService;

  constructor(opts: SandboxClientOptions) {
    this.rt = new ClientRuntime(opts);
    this.sessions = new SessionService(this.rt);
    this.operations = new OperationService(this.rt);
    this.dataPlane = new DataPlane(this.rt);
    this.transfers = new TransferService(this.operations);
  }

  createSession(opts: CreateOptions = {}): Promise<SessionHandle> {
    return this.sessions.create(opts);
  }

  /**
   * Create a sandbox and wait until it is READY. This is the recommended
   * application-facing entry point.
   */
  async create(opts: CreateOptions = {}): Promise<Sandbox> {
    const handle = await this.createSession(opts);
    await this.waitForReady(handle);
    return new Sandbox(this, handle);
  }

  attach(sessionId: string): SessionHandle {
    return this.sessions.attach(sessionId);
  }

  listLocalSessions(): StoredSession[] {
    return this.sessions.listLocal();
  }

  forgetLocal(sessionId: string): void {
    this.sessions.forgetLocal(sessionId);
  }

  status(handle: SessionHandle): Promise<SessionStatus> {
    return this.rt.status(handle);
  }

  waitForReady(handle: SessionHandle, timeoutMs = 180_000): Promise<SessionStatus> {
    return this.rt.waitForReady(handle, timeoutMs);
  }

  suspend(handle: SessionHandle): Promise<SessionStatus> {
    return this.sessions.suspend(handle);
  }

  resume(handle: SessionHandle, timeoutMs = 180_000): Promise<SessionStatus> {
    return this.sessions.resume(handle, timeoutMs);
  }

  destroy(handle: SessionHandle, waitMs = 30_000): Promise<SessionStatus | null> {
    return this.sessions.destroy(handle, waitMs);
  }

  uploadFile(
    handle: SessionHandle,
    localPath: string,
    remotePath: string,
    opts: TransferOptions = {},
  ): Promise<TransferOutcome> {
    return this.transfers.upload(handle, localPath, remotePath, opts);
  }

  downloadFile(
    handle: SessionHandle,
    remotePath: string,
    localPath: string,
    opts: TransferOptions = {},
  ): Promise<TransferOutcome> {
    return this.transfers.download(handle, remotePath, localPath, opts);
  }

  exec(handle: SessionHandle, opts: ExecOptions) {
    return this.operations.exec(handle, opts);
  }

  putFile(handle: SessionHandle, opts: FilePutOptions) {
    return this.operations.putFile(handle, opts);
  }

  getFile(handle: SessionHandle, path: string, archive = false, queueMs = 0) {
    return this.operations.getFile(handle, path, archive, queueMs);
  }

  listFiles(handle: SessionHandle, path = ".", recursive = false) {
    return this.operations.listFiles(handle, path, recursive);
  }

  statFile(handle: SessionHandle, path: string) {
    return this.operations.statFile(handle, path);
  }

  cancel(handle: SessionHandle, requestId: string): Promise<void> {
    return this.operations.cancel(handle, requestId);
  }

  getOperation(handle: SessionHandle, requestId: string, waitMs = 20_000): Promise<GuestResult | null> {
    return this.operations.getOperation(handle, requestId, waitMs);
  }

  startService(handle: SessionHandle, opts: StartServiceOptions) {
    return this.dataPlane.startService(handle, opts);
  }

  stopService(handle: SessionHandle, name: string): Promise<void> {
    return this.dataPlane.stopService(handle, name);
  }

  listServices(handle: SessionHandle) {
    return this.dataPlane.listServices(handle);
  }

  http(handle: SessionHandle, opts: HttpOptions): Promise<HttpResponse> {
    return this.dataPlane.http(handle, opts);
  }

  openHttpStream(handle: SessionHandle, opts: OpenHttpStreamOptions): Promise<HttpStream> {
    return this.dataPlane.openHttpStream(handle, opts);
  }

  openWebSocket(handle: SessionHandle, opts: OpenWebSocketOptions): Promise<WebSocketStream> {
    return this.dataPlane.openWebSocket(handle, opts);
  }
}

export * from "./types.js";
export type { FileEntry, SessionStatus } from "@x402s/shared";
