import type { Server } from "node:http";
import type { WebSocketServer, WebSocket } from "ws";
import type { AttestationEnvelope, GuestToRelay } from "@x402s/shared";
import { log } from "@x402s/shared";
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
    if (check === "connected") {
      log.warn("relay_duplicate_guest_connection", { sessionId });
      socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!registry.attach(sessionId, ws)) {
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
        if (!evidence || typeof evidence !== "object" || !registry.hello(sessionId, evidence)) {
          log.warn("relay_hello_binding_mismatch", { sessionId });
          ws.close(1008, "bad hello");
          return;
        }
        clearTimeout(helloTimer);
        log.info("relay_guest_ready", {
          sessionId,
          evidenceType: evidence.evidenceType,
          insecureDevOnly: evidence.insecureDevOnly,
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
