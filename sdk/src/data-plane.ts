/**
 * Data plane: local services, HTTP, SSE/chunked streams and WebSocket.
 * Everything travels in sealed envelopes through the relay.
 */
import { randomBytes } from "node:crypto";
import type {
  HttpRequestOperation,
  HttpResponseResult,
  HttpStreamCloseOperation,
  HttpStreamCloseResult,
  HttpStreamOpenOperation,
  HttpStreamOpenResult,
  HttpStreamReadOperation,
  HttpStreamReadResult,
  OperationError,
  ServiceInfo,
  ServiceListOperation,
  ServiceListResult,
  ServiceStartOperation,
  ServiceStartResult,
  ServiceStopOperation,
  ServiceStopResult,
  WsCloseOperation,
  WsCloseResult,
  WsOpenOperation,
  WsOpenResult,
  WsReadOperation,
  WsReadResult,
  WsSendOperation,
  WsSendResult,
} from "@x402s/shared";
import type { ClientRuntime } from "./runtime.js";
import { sleep } from "./runtime.js";
import {
  SandboxError,
  type HttpOptions,
  type HttpResponse,
  type HttpStream,
  type OpenHttpStreamOptions,
  type OpenWebSocketOptions,
  type SessionHandle,
  type StartServiceOptions,
  type WebSocketStream,
} from "./types.js";

export class DataPlane {
  constructor(private readonly rt: ClientRuntime) {}

  /** Start a long-running local server inside the sandbox. */
  async startService(handle: SessionHandle, opts: StartServiceOptions): Promise<ServiceInfo> {
    const requestId = randomBytes(16).toString("hex");
    const operation: ServiceStartOperation = {
      v: 2,
      sessionId: handle.sessionId,
      clientNonce: handle.clientNonce,
      requestId,
      op: "service.start",
      name: opts.name,
      command: opts.command,
      port: opts.port,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    };
    const result = await this.rt.run<ServiceStartResult | OperationError>(
      handle,
      operation,
      requestId,
      0,
      30_000,
      undefined,
    );
    if (!result.ok) {
      throw new SandboxError(result.error?.code ?? "service_start_failed", result.error?.message ?? "service start failed", undefined, requestId);
    }
    return result.service;
  }

  async stopService(handle: SessionHandle, name: string): Promise<void> {
    const requestId = randomBytes(16).toString("hex");
    const operation: ServiceStopOperation = {
      v: 2,
      sessionId: handle.sessionId,
      clientNonce: handle.clientNonce,
      requestId,
      op: "service.stop",
      name,
    };
    const result = await this.rt.run<ServiceStopResult | OperationError>(
      handle,
      operation,
      requestId,
      0,
      10_000,
      undefined,
    );
    if (!result.ok) {
      throw new SandboxError(result.error?.code ?? "service_stop_failed", result.error?.message ?? "service stop failed", undefined, requestId);
    }
  }

  async listServices(handle: SessionHandle): Promise<ServiceInfo[]> {
    const requestId = randomBytes(16).toString("hex");
    const operation: ServiceListOperation = {
      v: 2,
      sessionId: handle.sessionId,
      clientNonce: handle.clientNonce,
      requestId,
      op: "service.list",
    };
    const result = await this.rt.run<ServiceListResult | OperationError>(
      handle,
      operation,
      requestId,
      0,
      10_000,
      undefined,
    );
    if (!result.ok) {
      throw new SandboxError(result.error?.code ?? "service_list_failed", result.error?.message ?? "service list failed", undefined, requestId);
    }
    return result.services;
  }

  /** HTTP to a loopback-only service port; the guest never accepts a host. */
  async http(handle: SessionHandle, opts: HttpOptions): Promise<HttpResponse> {
    const requestId = randomBytes(16).toString("hex");
    const body =
      opts.body === undefined
        ? undefined
        : Buffer.from(typeof opts.body === "string" ? Buffer.from(opts.body) : opts.body);
    const operation: HttpRequestOperation = {
      v: 2,
      sessionId: handle.sessionId,
      clientNonce: handle.clientNonce,
      requestId,
      op: "http.request",
      port: opts.port,
      method: (opts.method ?? "GET").toUpperCase(),
      path: opts.path ?? "/",
      ...(opts.headers ? { headers: opts.headers } : {}),
      ...(body ? { bodyBase64: body.toString("base64") } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    };
    const result = await this.rt.run<HttpResponseResult | OperationError>(
      handle,
      operation,
      requestId,
      0,
      opts.timeoutMs ?? 30_000,
      undefined,
    );
    if (!result.ok) {
      throw new SandboxError(result.error?.code ?? "http_failed", result.error?.message ?? "http request failed", undefined, requestId);
    }
    return {
      status: result.status,
      headers: result.headers,
      body: Buffer.from(result.bodyBase64, "base64"),
      truncated: result.truncated,
    };
  }

  /**
   * Open a streaming HTTP response (SSE/chunked) through the relay. The stream
   * is polled with short sealed operations, so it does not hold the session's
   * operation slot while waiting.
   */
  async openHttpStream(handle: SessionHandle, opts: OpenHttpStreamOptions): Promise<HttpStream> {
    const self = this.rt;
    const body =
      opts.body === undefined
        ? undefined
        : Buffer.from(typeof opts.body === "string" ? Buffer.from(opts.body) : opts.body);
    const openId = randomBytes(16).toString("hex");
    const openOperation: HttpStreamOpenOperation = {
      v: 2,
      sessionId: handle.sessionId,
      clientNonce: handle.clientNonce,
      requestId: openId,
      op: "http.stream.open",
      port: opts.port,
      method: (opts.method ?? "GET").toUpperCase(),
      path: opts.path ?? "/",
      ...(opts.headers ? { headers: opts.headers } : {}),
      ...(body ? { bodyBase64: body.toString("base64") } : {}),
    };
    const opened = await self.run<HttpStreamOpenResult | OperationError>(
      handle,
      openOperation,
      openId,
      0,
      30_000,
      undefined,
    );
    if (!opened.ok) {
      throw new SandboxError(opened.error?.code ?? "stream_open_failed", opened.error?.message ?? "stream open failed", undefined, openId);
    }
    const streamId = opened.streamId;

    return {
      streamId,
      status: opened.status,
      headers: opened.headers,
      async read(): Promise<{ chunk?: Buffer; done: boolean }> {
        for (;;) {
          const requestId = randomBytes(16).toString("hex");
          const operation: HttpStreamReadOperation = {
            v: 2,
            sessionId: handle.sessionId,
            clientNonce: handle.clientNonce,
            requestId,
            op: "http.stream.read",
            streamId,
          };
          const result = await self.run<HttpStreamReadResult | OperationError>(
            handle,
            operation,
            requestId,
            0,
            10_000,
            undefined,
          );
          if (!result.ok) {
            throw new SandboxError(result.error?.code ?? "stream_read_failed", result.error?.message ?? "stream read failed", undefined, requestId);
          }
          if (result.pending) {
            await sleep(100);
            continue;
          }
          return {
            ...(result.chunkBase64 ? { chunk: Buffer.from(result.chunkBase64, "base64") } : {}),
            done: Boolean(result.done),
          };
        }
      },
      async close(): Promise<void> {
        const requestId = randomBytes(16).toString("hex");
        const operation: HttpStreamCloseOperation = {
          v: 2,
          sessionId: handle.sessionId,
          clientNonce: handle.clientNonce,
          requestId,
          op: "http.stream.close",
          streamId,
        };
        const result = await self.run<HttpStreamCloseResult | OperationError>(
          handle,
          operation,
          requestId,
          0,
          10_000,
          undefined,
        );
        if (!result.ok) {
          throw new SandboxError(result.error?.code ?? "stream_close_failed", result.error?.message ?? "stream close failed", undefined, requestId);
        }
      },
    };
  }

  /** Open a bidirectional WebSocket to a loopback service, polled over the relay. */
  async openWebSocket(handle: SessionHandle, opts: OpenWebSocketOptions): Promise<WebSocketStream> {
    const self = this.rt;
    const openId = randomBytes(16).toString("hex");
    const openOperation: WsOpenOperation = {
      v: 2,
      sessionId: handle.sessionId,
      clientNonce: handle.clientNonce,
      requestId: openId,
      op: "ws.open",
      port: opts.port,
      path: opts.path,
      ...(opts.headers ? { headers: opts.headers } : {}),
    };
    const opened = await self.run<WsOpenResult | OperationError>(
      handle,
      openOperation,
      openId,
      0,
      30_000,
      undefined,
    );
    if (!opened.ok) {
      throw new SandboxError(opened.error?.code ?? "ws_open_failed", opened.error?.message ?? "websocket open failed", undefined, openId);
    }
    const streamId = opened.streamId;
    return {
      streamId,
      status: opened.status,
      async read(): Promise<{ data?: Buffer; binary: boolean; done: boolean }> {
        for (;;) {
          const requestId = randomBytes(16).toString("hex");
          const operation: WsReadOperation = {
            v: 2,
            sessionId: handle.sessionId,
            clientNonce: handle.clientNonce,
            requestId,
            op: "ws.read",
            streamId,
          };
          const result = await self.run<WsReadResult | OperationError>(
            handle,
            operation,
            requestId,
            0,
            10_000,
            undefined,
          );
          if (!result.ok) {
            throw new SandboxError(result.error?.code ?? "ws_read_failed", result.error?.message ?? "websocket read failed", undefined, requestId);
          }
          if (result.pending) {
            await sleep(100);
            continue;
          }
          return {
            ...(result.chunkBase64 ? { data: Buffer.from(result.chunkBase64, "base64") } : {}),
            binary: Boolean(result.binary),
            done: Boolean(result.done),
          };
        }
      },
      async send(data: Buffer | Uint8Array | string, opts?: { binary?: boolean }): Promise<void> {
        const requestId = randomBytes(16).toString("hex");
        const buf = Buffer.from(typeof data === "string" ? Buffer.from(data) : data);
        const operation: WsSendOperation = {
          v: 2,
          sessionId: handle.sessionId,
          clientNonce: handle.clientNonce,
          requestId,
          op: "ws.send",
          streamId,
          bodyBase64: buf.toString("base64"),
          ...(opts?.binary ? { binary: true } : {}),
        };
        const result = await self.run<WsSendResult | OperationError>(
          handle,
          operation,
          requestId,
          0,
          10_000,
          undefined,
        );
        if (!result.ok) {
          throw new SandboxError(result.error?.code ?? "ws_send_failed", result.error?.message ?? "websocket send failed", undefined, requestId);
        }
      },
      async close(): Promise<void> {
        const requestId = randomBytes(16).toString("hex");
        const operation: WsCloseOperation = {
          v: 2,
          sessionId: handle.sessionId,
          clientNonce: handle.clientNonce,
          requestId,
          op: "ws.close",
          streamId,
        };
        const result = await self.run<WsCloseResult | OperationError>(
          handle,
          operation,
          requestId,
          0,
          10_000,
          undefined,
        );
        if (!result.ok) {
          throw new SandboxError(result.error?.code ?? "ws_close_failed", result.error?.message ?? "websocket close failed", undefined, requestId);
        }
      },
    };
  }
}
