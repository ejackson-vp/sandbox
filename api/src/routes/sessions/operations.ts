/**
 * The operations surface: one POST for every command, one GET for every read.
 *
 * Both carry the operation inside the sealed envelope, so the URL cannot change
 * what the guest does and the API never sees the command. The POST is wrapped
 * in the in-flight gauge and the duration histogram, because it is the one
 * request that can hold a connection open for a minute.
 */
import express, { type Request, type RequestHandler, type Response } from "express";
import { LATENCY_BUCKETS, metrics } from "@x402s/shared/runtime";
import type { ApiConfig } from "../../config.js";
import { operationSchema, payloadHashSchema, rejectPlaintextBodies } from "../../schemas.js";
import { invalidRequest } from "../errors.js";
import type { Authorizer, SessionsDeps } from "./authorize.js";
import { respondControllerError, validRequestId, writeOperation } from "./respond.js";

export function mountOperationRoutes(
  router: express.Router,
  deps: SessionsDeps,
  readLimit: RequestHandler,
  authorize: Authorizer,
): void {
  // Every operation carries its type inside the sealed envelope. The URL is
  // deliberately opaque: a path cannot change what the guest does.
  router.post("/v1/sessions/:id/operations", readLimit, rejectPlaintextBodies, (req, res) =>
    runOperation(req, res, deps, authorize),
  );

  // Download/list/stat: the request (path and options) is inside the encrypted
  // envelope too, so the API never learns what is being read.
  router.get("/v1/sessions/:id/operations", readLimit, (req, res) => fileGet(req, res, deps, authorize));
}

async function runOperation(
  req: Request,
  res: Response,
  deps: SessionsDeps,
  authorize: Authorizer,
): Promise<void> {
  const started = Date.now();
  metrics.gauge("sandbox_operations_active", "Operations in flight").inc();
  res.on("finish", () => {
    metrics.gauge("sandbox_operations_active", "Operations in flight").dec();
    metrics.histogram("sandbox_operation_duration_seconds", "Operation duration", LATENCY_BUCKETS).observe((Date.now() - started) / 1000);
    metrics.counter("sandbox_operations_total", "Operations by result").inc({ result: res.statusCode < 300 ? "ok" : "error" });
  });
  const session = await authorize(req, res);
  if (!session) return;
  if (session.state === "SUSPENDED") {
    res.status(409).json({
      error: "session_suspended",
      message: "resume the session before sending operations",
    });
    return;
  }
  const parsed = operationSchema.safeParse(req.body);
  if (!parsed.success) {
    invalidRequest(res, parsed.error.issues);
    return;
  }
  try {
    const out = await deps.controller.operation(session.sessionId, {
      requestId: parsed.data.requestId,
      envelope: parsed.data.envelope,
      waitMs: operationWaitMs(parsed.data, deps.config),
      ...(parsed.data.payloadHash ? { payloadHash: parsed.data.payloadHash } : {}),
    });
    writeOperation(res, out.requestId, out);
  } catch (err) {
    respondControllerError(res, err, {
      log: "operation_failed",
      // A lease that ran out mid-command is a 410, so the client stops retrying.
      translate: (e) => ({ status: e.code === "lease_expired" ? 410 : e.status }),
    });
  }
}

/**
 * 90 s, not 120: the public API sits behind an edge proxy that answers 524 at
 * 100 s. A long command must come back `202 pending` so the client can re-poll,
 * so the default wait stays under that ceiling.
 */
function operationWaitMs(
  data: { waitMs?: number; timeoutMs?: number },
  config: ApiConfig,
): number {
  return (
    data.waitMs ??
    Math.min(90_000, (data.timeoutMs ?? config.platformLimits.maxCommandSeconds * 1000) + 5_000)
  );
}

async function fileGet(
  req: Request,
  res: Response,
  deps: SessionsDeps,
  authorize: Authorizer,
): Promise<void> {
  const session = await authorize(req, res);
  if (!session) return;
  const query = readFileGetQuery(req, res);
  if (!query) return;
  try {
    const out = await deps.controller.operation(session.sessionId, {
      requestId: query.requestId,
      envelope: query.envelope,
      waitMs: 60_000,
      ...(query.payloadHash ? { payloadHash: query.payloadHash } : {}),
    });
    writeOperation(res, out.requestId, out);
  } catch (err) {
    // The read path passes the controller's status and code through, 410
    // included, rather than reinterpreting either.
    respondControllerError(res, err, { log: "file_get_failed" });
  }
}

interface FileGetQuery {
  requestId: string;
  envelope: string;
  payloadHash: string | undefined;
}

/** The GET's query string, or null after writing the 400 that refuses it. */
function readFileGetQuery(req: Request, res: Response): FileGetQuery | null {
  const raw = req.query.request;
  const requestId = validRequestId(req.query.requestId);
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2 * 1024 * 1024) {
    res.status(400).json({ error: "request_envelope_required" });
    return null;
  }
  if (requestId === null) {
    res.status(400).json({ error: "invalid_request_id" });
    return null;
  }
  // Standard base64 only. Guessing base64url from `-`/`_` could silently
  // reinterpret a payload as different bytes. Clients percent-encode the value,
  // so `+` and `/` are safe in the query string.
  if (raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    res.status(400).json({ error: "invalid_envelope_encoding" });
    return null;
  }
  const rawPayloadHash = req.query.payloadHash;
  if (rawPayloadHash === undefined) return { requestId, envelope: raw, payloadHash: undefined };
  // Optional: the client-computed canonical operation hash. A malformed value
  // is refused rather than ignored, because silently falling back would hide a
  // client bug and change which payload the request id is bound to.
  if (typeof rawPayloadHash !== "string" || !payloadHashSchema.safeParse(rawPayloadHash).success) {
    res.status(400).json({ error: "invalid_payload_hash" });
    return null;
  }
  return { requestId, envelope: raw, payloadHash: rawPayloadHash };
}
