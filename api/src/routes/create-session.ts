/**
 * Create-session route: HTTP mapping only.
 *
 * The per-IP admission, the schema check and the response write happen here.
 * Everything the x402 handshake decides lives in the use case
 * (`use-cases/create-session.ts`), which returns a discriminated result instead
 * of touching the socket, so the ordering of payment and capacity side effects
 * is testable without an Express response.
 */
import type { Request, Response } from "express";
import type { PaymentRequirements } from "@x402/core/types";
import type { CreateSessionRequest } from "@x402s/shared/protocol";
import { LATENCY_BUCKETS, metrics, recordRateLimited } from "@x402s/shared/runtime";
import type { RateLimiter } from "../admission.js";
import { createSchema } from "../schemas.js";
import {
  createSession,
  type CreateSessionResult,
  type CreateSessionUseCaseDeps,
} from "../use-cases/create-session.js";

interface CreateSessionDeps extends CreateSessionUseCaseDeps {
  ipCreateLimiter: RateLimiter;
  payment402(res: Response, requirement: PaymentRequirements, error: string): Promise<void>;
}

/**
 * Write the use case's answer. A 402 goes through `payment402`, which issues a
 * fresh challenge nonce and encodes PAYMENT-REQUIRED; everything else is a
 * status, optional headers and a JSON body.
 */
async function writeResult(
  deps: CreateSessionDeps,
  res: Response,
  result: CreateSessionResult,
): Promise<void> {
  if (result.kind === "payment_required") {
    await deps.payment402(res, result.requirement, result.error);
    return;
  }
  for (const [name, value] of Object.entries(result.headers ?? {})) {
    res.setHeader(name, value);
  }
  res.status(result.status).json(result.body);
}

export function createSessionHandler(deps: CreateSessionDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const apiReceivedAt = Date.now();
    res.on("finish", () => {
      metrics
        .histogram("sandbox_session_create_duration_seconds", "Create request duration", LATENCY_BUCKETS)
        .observe((Date.now() - apiReceivedAt) / 1000);
      metrics
        .counter("sandbox_sessions_created_total", "Session create requests by outcome")
        .inc({ result: res.statusCode < 300 ? "ok" : res.statusCode === 402 ? "payment_required" : "error" });
    });
    const sourceIp = req.ip ?? "unknown";
    if (!deps.ipCreateLimiter.take(sourceIp)) {
      recordRateLimited("ip");
      res.setHeader("Retry-After", String(deps.ipCreateLimiter.retryAfterSeconds(sourceIp)));
      res.status(429).json({ error: "rate_limited", scope: "ip" });
      return;
    }
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const body: CreateSessionRequest = parsed.data;
    const result = await createSession(deps, {
      body,
      paymentHeader: req.header("PAYMENT-SIGNATURE") ?? req.header("X-PAYMENT"),
      sourceIp,
      receivedAt: apiReceivedAt,
    });
    await writeResult(deps, res, result);
  };
}
