/**
 * Data plane: local services, HTTP, SSE/chunked streams and WebSocket.
 * Everything travels in sealed envelopes through the relay.
 *
 * Each method is a translation from public options to one operation. The
 * send-and-raise step is identical for all of them, so it lives in `send()`:
 * a method that forgets to check `ok` would otherwise return a half-built
 * object instead of raising the guest's refusal.
 */
import { randomBytes } from "node:crypto";
import type {
  GuestRequest,
  GuestResult,
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
} from "@x402s/shared/protocol";
import type { ClientRuntime } from "./runtime.js";
import { sleep } from "./timing.js";
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

  /**
   * Run one operation and raise the guest's refusal as a `SandboxError`.
   *
   * `fallback` is the code and message a refusal without a classified error
   * carries, which is per operation: a caller must be able to tell "service
   * start failed" from "stream read failed" without parsing the message.
   */
  private async send<T extends GuestResult>(
    handle: SessionHandle,
    operation: GuestRequest,
    timeoutMs: number,
    fallback: { code: string; message: string },
  ): Promise<T> {
    const result = await this.rt.run<T | OperationError>(
      handle,
      operation,
      operation.requestId,
      0,
      timeoutMs,
      undefined,
    );
    if (!result.ok) {
      throw new SandboxError(
        result.error?.code ?? fallback.code,
        result.error?.message ?? fallback.message,
        undefined,
        operation.requestId,
      );
    }
    return result as T;
  }

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
    const result = await this.send<ServiceStartResult>(handle, operation, 30_000, {
      code: "service_start_failed",
      message: "service start failed",
    });
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
    await this.send<ServiceStopResult>(handle, operation, 10_000, {
      code: "service_stop_failed",
      message: "service stop failed",
    });
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
    const result = await this.send<ServiceListResult>(handle, operation, 10_000, {
      code: "service_list_failed",
      message: "service list failed",
    });
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
    const result = await this.send<HttpResponseResult>(handle, operation, opts.timeoutMs ?? 30_000, {
      code: "http_failed",
      message: "http request failed",
    });
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
    // The returned stream object has its own `send`/`read`/`close`, so `this`
    // inside those closures is the stream, not the plane.
    const plane = this;
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
    const opened = await this.send<HttpStreamOpenResult>(handle, openOperation, 30_000, {
      code: "stream_open_failed",
      message: "stream open failed",
    });
    const streamId = opened.streamId;

    return {
      streamId,
      status: opened.status,
      headers: opened.headers,
      async read(): Promise<{ chunk?: Buffer; done: boolean }> {
        for (;;) {
          const operation: HttpStreamReadOperation = {
            v: 2,
            sessionId: handle.sessionId,
            clientNonce: handle.clientNonce,
            requestId: randomBytes(16).toString("hex"),
            op: "http.stream.read",
            streamId,
          };
          const result = await plane.send<HttpStreamReadResult>(handle, operation, 10_000, {
            code: "stream_read_failed",
            message: "stream read failed",
          });
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
        const operation: HttpStreamCloseOperation = {
          v: 2,
          sessionId: handle.sessionId,
          clientNonce: handle.clientNonce,
          requestId: randomBytes(16).toString("hex"),
          op: "http.stream.close",
          streamId,
        };
        await plane.send<HttpStreamCloseResult>(handle, operation, 10_000, {
          code: "stream_close_failed",
          message: "stream close failed",
        });
      },
    };
  }

  /** Open a bidirectional WebSocket to a loopback service, polled over the relay. */
  async openWebSocket(handle: SessionHandle, opts: OpenWebSocketOptions): Promise<WebSocketStream> {
    const plane = this;
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
    const opened = await this.send<WsOpenResult>(handle, openOperation, 30_000, {
      code: "ws_open_failed",
      message: "websocket open failed",
    });
    const streamId = opened.streamId;
    return {
      streamId,
      status: opened.status,
      async read(): Promise<{ data?: Buffer; binary: boolean; done: boolean }> {
        for (;;) {
          const operation: WsReadOperation = {
            v: 2,
            sessionId: handle.sessionId,
            clientNonce: handle.clientNonce,
            requestId: randomBytes(16).toString("hex"),
            op: "ws.read",
            streamId,
          };
          const result = await plane.send<WsReadResult>(handle, operation, 10_000, {
            code: "ws_read_failed",
            message: "websocket read failed",
          });
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
        const buf = Buffer.from(typeof data === "string" ? Buffer.from(data) : data);
        const operation: WsSendOperation = {
          v: 2,
          sessionId: handle.sessionId,
          clientNonce: handle.clientNonce,
          requestId: randomBytes(16).toString("hex"),
          op: "ws.send",
          streamId,
          bodyBase64: buf.toString("base64"),
          ...(opts?.binary ? { binary: true } : {}),
        };
        await plane.send<WsSendResult>(handle, operation, 10_000, {
          code: "ws_send_failed",
          message: "websocket send failed",
        });
      },
      async close(): Promise<void> {
        const operation: WsCloseOperation = {
          v: 2,
          sessionId: handle.sessionId,
          clientNonce: handle.clientNonce,
          requestId: randomBytes(16).toString("hex"),
          op: "ws.close",
          streamId,
        };
        await plane.send<WsCloseResult>(handle, operation, 10_000, {
          code: "ws_close_failed",
          message: "websocket close failed",
        });
      },
    };
  }
}
