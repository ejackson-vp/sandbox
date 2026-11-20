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
import { resolveSessionSpec } from "@x402s/shared/payment";
import { LATENCY_BUCKETS, metrics, recordRateLimited } from "@x402s/shared/runtime";
import type { RateLimiter } from "../admission.js";
import { createSchema } from "../schemas.js";
import { createSession } from "../use-cases/create-session.js";
import type {
  CreateSessionResult,
  CreateSessionUseCaseDeps,
} from "../use-cases/create-session-contract.js";
import { invalidRequest } from "./errors.js";

interface CreateSessionDeps extends CreateSessionUseCaseDeps {
  ipCreateLimiter: RateLimiter;
  payment402(res: Response, requirement: PaymentRequirements, error: string): Promise<void>;
}

/**
 * A catalogue probe: an empty body with no payment attached.
 *
 * The only way an indexer learns which body to send is the 402 that advertises
 * the example, and it cannot get one from a route that validates first: it
 * posts `{}`, is told the request is invalid, and never sees the extension. An
 * empty body cannot be a buyer's intent, so quoting the default tier costs
 * nothing and spends one challenge nonce; every non-empty body that fails the
 * schema is still a client error.
 */
function isCatalogueProbe(req: Request): boolean {
  const body = req.body as unknown;
  const empty =
    body === undefined ||
    body === null ||
    (typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0);
  return empty && !req.header("PAYMENT-SIGNATURE") && !req.header("X-PAYMENT");
}

/** The default tier's price, for a probe that named nothing. */
async function quoteDefaultTier(deps: CreateSessionDeps): Promise<PaymentRequirements | null> {
  const resolution = resolveSessionSpec(
    { clientPublicKey: "A".repeat(44), clientNonce: "B".repeat(44) },
    deps.config.tiers,
    deps.config.platformLimits,
  );
  if (!resolution.ok) return null;
  return deps.requirementFor(resolution.priceUsd, resolution.spec);
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
      if (isCatalogueProbe(req)) {
        const requirement = await quoteDefaultTier(deps);
        if (requirement) {
          await deps.payment402(res, requirement, "payment_required");
          return;
        }
      }
      invalidRequest(res, parsed.error.issues);
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
