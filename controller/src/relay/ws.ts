import type { Server } from "node:http";
import type { Socket } from "node:net";
import type { WebSocketServer, WebSocket } from "ws";
import type { AttestationEnvelope, GuestToRelay } from "@x402s/shared/protocol";
import { log, metrics } from "@x402s/shared/runtime";
import { MAX_FRAME_BYTES, type RelayRegistry } from "./registry.js";
import { disconnectReasonLabel } from "./metrics.js";

const HELLO_TIMEOUT_MS = 15_000;

export function attachGuestUpgrade(
  server: Server,
  wss: WebSocketServer,
  registry: RelayRegistry,
): void {
  server.on("upgrade", (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://relay.local");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/guest") {
      socket.destroy();
      return;
    }
    const sessionId = url.searchParams.get("session") ?? "";
    const token = url.searchParams.get("token") ?? "";
    const check = registry.precheck(sessionId, token);
    if (check === "not_found" || check === "expired") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    if (check === "bad_token") {
      log.warn("relay_bad_guest_token", { sessionId });
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    if (check === "wrong_shard") {
      // The guest reached a relay that does not own its session. The registry
      // is in memory, so serving it here would register the session somewhere
      // the controller never looks. 421 Misdirected Request names the fault.
      metrics
        .counter("sandbox_relay_cross_shard_total", "Guest upgrades refused for landing on the wrong shard")
        .inc({ service: "relay" });
      log.warn("relay_cross_shard_rejected", { sessionId });
      socket.write("HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (check === "connected") {
      log.warn("relay_duplicate_guest_connection", { sessionId });
      socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!registry.attach(sessionId, ws, socket as Socket)) {
        ws.close(1008, "already connected");
        return;
      }
      log.info("relay_guest_connected", { sessionId });
      handleGuestConnection(registry, sessionId, ws);
    });
  });
}

function handleGuestConnection(registry: RelayRegistry, sessionId: string, ws: WebSocket): void {
  const helloTimer = setTimeout(() => {
    log.warn("relay_hello_timeout", { sessionId });
    ws.close(1008, "hello timeout");
  }, HELLO_TIMEOUT_MS);

  const ping = setInterval(() => {
    if (ws.readyState === 1) ws.ping();
  }, 15_000);

  ws.on("message", (data, isBinary) => {
    if (isBinary || (data as Buffer).length > MAX_FRAME_BYTES) {
      ws.close(1009, "unsupported frame");
      return;
    }
    let msg: GuestToRelay;
    try {
      msg = JSON.parse(data.toString()) as GuestToRelay;
    } catch {
      ws.close(1003, "invalid json");
      return;
    }
    if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") {
      ws.close(1003, "invalid message");
      return;
    }

    switch (msg.type) {
      case "hello": {
        const evidence = msg.evidence as AttestationEnvelope;
        const meta = helloMetadata(msg);
        if (!evidence || typeof evidence !== "object" || meta === null) {
          log.warn("relay_hello_binding_mismatch", { sessionId });
          ws.close(1008, "bad hello");
          return;
        }
        if (!registry.hello(sessionId, evidence, meta)) {
          log.warn("relay_hello_binding_mismatch", { sessionId });
          ws.close(1008, "bad hello");
          return;
        }
        clearTimeout(helloTimer);
        log.info("relay_guest_ready", {
          sessionId,
          evidenceType: evidence.evidenceType,
          insecureDevOnly: evidence.insecureDevOnly,
          // Version only: the capability list is operational metadata and the
          // shared log policy forbids logging capability sets.
          protocolVersion: meta.protocolVersion ?? null,
        });
        return;
      }
      case "response": {
        if (typeof msg.id !== "string" || typeof msg.envelope !== "string" || msg.envelope.length > MAX_FRAME_BYTES) {
          ws.close(1009, "bad response");
          return;
        }
        const result = registry.response(sessionId, msg.id, msg.envelope);
        if (result === "duplicate") {
          log.warn("relay_duplicate_response", { sessionId, requestId: msg.id });
          return;
        }
        log.info("relay_response_received", {
          sessionId,
          requestId: msg.id,
          envelopeBytes: msg.envelope.length,
        });
        return;
      }
      case "status": {
        if (
          typeof msg.activeRequestId !== "string" ||
          msg.activeRequestId.length > 128 ||
          typeof msg.epoch !== "number" ||
          !Number.isFinite(msg.epoch) ||
          msg.epoch < 0
        ) {
          ws.close(1008, "bad status");
          return;
        }
        const result = registry.status(sessionId, msg.activeRequestId, msg.epoch);
        if (result === "unknown") {
          ws.close(1008, "unknown session");
          return;
        }
        return;
      }
      case "error": {
        const id = typeof msg.id === "string" ? msg.id : "";
        const result = registry.error(
          sessionId,
          id,
          String(msg.code ?? "guest_error"),
          String(msg.message ?? msg.code ?? "guest_error"),
        );
        if (result === "duplicate") {
          log.warn("relay_duplicate_error", { sessionId, requestId: id });
          return;
        }
        log.warn("relay_guest_error", {
          sessionId,
          errorCode: String(msg.code ?? "guest_error"),
          requestId: id,
        });
        return;
      }
      default:
        ws.close(1003, "unknown message type");
    }
  });

  ws.on("close", (code: number) => {
    clearInterval(ping);
    clearTimeout(helloTimer);
    registry.detach(sessionId, ws);
    registry.recordDisconnect(disconnectReasonLabel(code));
    log.info("relay_guest_disconnected", { sessionId });
  });

  ws.on("error", () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });
}

const MAX_CAPABILITIES = 64;
const MAX_CAPABILITY_LENGTH = 64;

/**
 * Optional hello metadata, sanitised.
 *
 * Absent fields are valid: a guest built before version negotiation omits both
 * and must still reach READY. A present field with the wrong shape is a
 * malformed frame, not an old guest, so it fails closed rather than being
 * silently dropped.
 */
function helloMetadata(
  msg: GuestToRelay,
): { protocolVersion?: number; capabilities?: readonly string[] } | null {
  if (msg.type !== "hello") return null;
  const version = msg.protocolVersion;
  if (version !== undefined && (!Number.isInteger(version) || version < 0)) return null;
  const capabilities = msg.capabilities;
  if (capabilities !== undefined) {
    if (!Array.isArray(capabilities) || capabilities.length > MAX_CAPABILITIES) return null;
    for (const capability of capabilities) {
      if (typeof capability !== "string" || capability.length === 0 || capability.length > MAX_CAPABILITY_LENGTH) {
        return null;
      }
    }
  }
  return {
    ...(version !== undefined ? { protocolVersion: version } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
  };
}
