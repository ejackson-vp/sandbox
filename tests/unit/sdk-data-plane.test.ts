/**
 * The data plane's protocol contract.
 *
 * Every method here is a thin translation between the public options and one
 * sealed operation, and each translation is where a mistake is invisible: a
 * method that is not uppercased, a body that is not base64, a chunk decoded as
 * text, a port defaulted on the wrong side. The runtime is stubbed at `run`,
 * which is the port the data plane uses, so the assertions are on the operation
 * that would be sealed and on what the caller gets back.
 */
import { describe, expect, it } from "vitest";
import { DataPlane } from "../../sdk/src/data-plane.js";
import { SandboxError, type SessionHandle } from "../../sdk/src/types.js";
import type { ClientRuntime } from "../../sdk/src/runtime.js";

const handle = {
  sessionId: "sbx_data_plane",
  capability: "cap",
  clientPublicKey: new Uint8Array(32),
  clientPrivateKey: new Uint8Array(32),
  clientNonce: "nonce",
  createdAt: 0,
} satisfies SessionHandle;

interface Sent {
  operation: Record<string, unknown>;
  requestId: string;
  queueMs: number;
  timeoutMs?: number;
}

type Answer = Record<string, unknown> | Error;

/** A runtime whose `run` returns the queued answers in order. */
function plane(answers: Answer[]): { dataPlane: DataPlane; sent: Sent[] } {
  const sent: Sent[] = [];
  const rt = {
    async run(_handle: SessionHandle, operation: { requestId: string }, requestId: string, queueMs: number, timeoutMs?: number) {
      sent.push({ operation: operation as unknown as Record<string, unknown>, requestId, queueMs, timeoutMs });
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      if (!answer) throw new Error("unexpected operation");
      return answer;
    },
  } as unknown as ClientRuntime;
  return { dataPlane: new DataPlane(rt), sent };
}

describe("services", () => {
  it("starts a service and returns the guest's description of it", async () => {
    const { dataPlane, sent } = plane([
      { ok: true, service: { name: "web", port: 8080, pid: 12, command: ["node", "server.js"] } },
    ]);
    const info = await dataPlane.startService(handle, {
      name: "web",
      command: ["node", "server.js"],
      port: 8080,
      env: { NODE_ENV: "production" },
      cwd: "/workspace/app",
    });

    expect(info).toMatchObject({ name: "web", port: 8080 });
    expect(sent[0]!.operation).toMatchObject({
      v: 2,
      sessionId: handle.sessionId,
      clientNonce: handle.clientNonce,
      op: "service.start",
      name: "web",
      command: ["node", "server.js"],
      port: 8080,
      env: { NODE_ENV: "production" },
      cwd: "/workspace/app",
    });
  });

  it("omits env and cwd rather than sending empty ones", async () => {
    const { dataPlane, sent } = plane([{ ok: true, service: { name: "web" } }]);
    await dataPlane.startService(handle, { name: "web", command: ["true"], port: 1 });
    expect(sent[0]!.operation).not.toHaveProperty("env");
    expect(sent[0]!.operation).not.toHaveProperty("cwd");
  });

  it("raises the guest's code when a service will not start", async () => {
    const { dataPlane } = plane([{ ok: false, error: { code: "port_in_use", message: "8080 is taken" } }]);
    const error = await dataPlane
      .startService(handle, { name: "web", command: ["true"], port: 8080 })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SandboxError);
    expect(error).toMatchObject({ code: "port_in_use", message: "8080 is taken" });
  });

  it("names the failure when the guest gives no code", async () => {
    const { dataPlane } = plane([{ ok: false }]);
    await expect(dataPlane.stopService(handle, "web")).rejects.toMatchObject({ code: "service_stop_failed" });
  });

  it("lists services from the guest's answer", async () => {
    const { dataPlane } = plane([{ ok: true, services: [{ name: "web", port: 8080 }] }]);
    expect(await dataPlane.listServices(handle)).toHaveLength(1);
  });

  it("stops a service by name", async () => {
    const { dataPlane, sent } = plane([{ ok: true }]);
    await dataPlane.stopService(handle, "web");
    expect(sent[0]!.operation).toMatchObject({ op: "service.stop", name: "web" });
  });
});

describe("http", () => {
  it("sends a base64 body, an uppercased method and the guest's port", async () => {
    const { dataPlane, sent } = plane([
      {
        ok: true,
        status: 201,
        headers: { "content-type": "application/json" },
        bodyBase64: Buffer.from("{\"ok\":true}").toString("base64"),
        truncated: false,
      },
    ]);
    const response = await dataPlane.http(handle, {
      port: 8080,
      method: "post",
      path: "/items",
      headers: { "x-token": "t" },
      body: Buffer.from("payload"),
      timeoutMs: 5_000,
    });

    expect(response.status).toBe(201);
    expect(response.body.toString()).toBe("{\"ok\":true}");
    expect(response.truncated).toBe(false);
    expect(sent[0]!.operation).toMatchObject({
      op: "http.request",
      port: 8080,
      method: "POST",
      path: "/items",
      headers: { "x-token": "t" },
      bodyBase64: Buffer.from("payload").toString("base64"),
      timeoutMs: 5_000,
    });
    expect(sent[0]!.timeoutMs).toBe(5_000);
  });

  it("defaults to GET / with no body and the standard timeout", async () => {
    const { dataPlane, sent } = plane([{ ok: true, status: 200, headers: {}, bodyBase64: "", truncated: false }]);
    await dataPlane.http(handle, { port: 8080 });
    expect(sent[0]!.operation).toMatchObject({ method: "GET", path: "/" });
    expect(sent[0]!.operation).not.toHaveProperty("bodyBase64");
    expect(sent[0]!.timeoutMs).toBe(30_000);
  });

  it("accepts a string body and encodes it as UTF-8", async () => {
    const { dataPlane, sent } = plane([{ ok: true, status: 200, headers: {}, bodyBase64: "", truncated: false }]);
    await dataPlane.http(handle, { port: 8080, method: "PUT", body: "héllo" });
    expect(sent[0]!.operation.bodyBase64).toBe(Buffer.from("héllo").toString("base64"));
  });

  it("maps a refused request to a SandboxError the caller can branch on", async () => {
    const { dataPlane } = plane([{ ok: false, error: { code: "egress_blocked", message: "not allowed" } }]);
    await expect(dataPlane.http(handle, { port: 8080 })).rejects.toMatchObject({
      code: "egress_blocked",
      status: undefined,
    });
  });
});

describe("streaming HTTP", () => {
  it("opens a stream and reads one chunk, treating pending as not yet", async () => {
    const { dataPlane, sent } = plane([
      { ok: true, streamId: "stream-1", status: 200, headers: { "content-type": "text/event-stream" } },
      { ok: true, pending: true },
      { ok: true, chunkBase64: Buffer.from("data: 1\n\n").toString("base64"), done: false },
      { ok: true, done: true },
      { ok: true },
    ]);
    const stream = await dataPlane.openHttpStream(handle, { port: 8080, path: "/events" });
    expect(stream).toMatchObject({ streamId: "stream-1", status: 200 });

    const first = await stream.read();
    expect(first.chunk?.toString()).toBe("data: 1\n\n");
    expect(first.done).toBe(false);
    expect(await stream.read()).toEqual({ done: true });
    await stream.close();

    expect(sent[1]!.operation).toMatchObject({ op: "http.stream.read", streamId: "stream-1" });
    expect(sent[4]!.operation).toMatchObject({ op: "http.stream.close", streamId: "stream-1" });
  });

  it("refuses to hand back a stream it could not open", async () => {
    const { dataPlane } = plane([{ ok: false, error: { code: "upstream_refused" } }]);
    await expect(dataPlane.openHttpStream(handle, { port: 8080, path: "/" })).rejects.toMatchObject({
      code: "upstream_refused",
    });
  });

  it("surfaces a read failure instead of reporting the stream done", async () => {
    const { dataPlane } = plane([
      { ok: true, streamId: "stream-1", status: 200, headers: {} },
      { ok: false, error: { code: "stream_gone", message: "the guest closed it" } },
    ]);
    const stream = await dataPlane.openHttpStream(handle, { port: 8080, path: "/" });
    await expect(stream.read()).rejects.toMatchObject({ code: "stream_gone" });
  });

  it("surfaces a close failure", async () => {
    const { dataPlane } = plane([
      { ok: true, streamId: "stream-1", status: 200, headers: {} },
      { ok: false },
    ]);
    const stream = await dataPlane.openHttpStream(handle, { port: 8080, path: "/" });
    await expect(stream.close()).rejects.toMatchObject({ code: "stream_close_failed" });
  });
});

describe("websockets", () => {
  it("reads text, sends binary and closes", async () => {
    const { dataPlane, sent } = plane([
      { ok: true, streamId: "ws-1", status: 101 },
      { ok: true, chunkBase64: Buffer.from("hello").toString("base64"), binary: false, done: false },
      { ok: true },
      { ok: true },
    ]);
    const socket = await dataPlane.openWebSocket(handle, { port: 8080, path: "/ws" });
    expect(socket).toMatchObject({ streamId: "ws-1", status: 101 });

    const message = await socket.read();
    expect(message.data?.toString()).toBe("hello");
    expect(message.binary).toBe(false);

    await socket.send("ping");
    await socket.close();

    expect(sent[1]!.operation).toMatchObject({ op: "ws.read", streamId: "ws-1" });
    expect(sent[2]!.operation).toMatchObject({
      op: "ws.send",
      streamId: "ws-1",
      bodyBase64: Buffer.from("ping").toString("base64"),
    });
    expect(sent[2]!.operation).not.toHaveProperty("binary");
    expect(sent[3]!.operation).toMatchObject({ op: "ws.close", streamId: "ws-1" });
  });

  it("marks a binary frame and skips the pending poll", async () => {
    const { dataPlane, sent } = plane([
      { ok: true, streamId: "ws-2", status: 101 },
      { ok: true, pending: true },
      { ok: true, chunkBase64: Buffer.from([0, 1, 2]).toString("base64"), binary: true, done: true },
      { ok: true },
    ]);
    const socket = await dataPlane.openWebSocket(handle, { port: 8080, path: "/ws" });
    const frame = await socket.read();
    expect(frame).toMatchObject({ binary: true, done: true });
    expect(frame.data).toEqual(Buffer.from([0, 1, 2]));
    await socket.send(Buffer.from([9]), { binary: true });
    expect(sent[3]!.operation).toMatchObject({ binary: true });
  });

  it("refuses a socket it could not open", async () => {
    const { dataPlane } = plane([{ ok: false, error: { code: "ws_refused", message: "no service on 8080" } }]);
    await expect(dataPlane.openWebSocket(handle, { port: 8080, path: "/ws" })).rejects.toMatchObject({
      code: "ws_refused",
    });
  });

  it("surfaces read, send and close failures with their own codes", async () => {
    const { dataPlane } = plane([
      { ok: true, streamId: "ws-3", status: 101 },
      { ok: false },
      { ok: false },
      { ok: false },
    ]);
    const socket = await dataPlane.openWebSocket(handle, { port: 8080, path: "/ws" });
    await expect(socket.read()).rejects.toMatchObject({ code: "ws_read_failed" });
    await expect(socket.send("x")).rejects.toMatchObject({ code: "ws_send_failed" });
    await expect(socket.close()).rejects.toMatchObject({ code: "ws_close_failed" });
  });
});
