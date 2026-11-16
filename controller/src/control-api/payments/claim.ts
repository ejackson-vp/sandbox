/**
 * Claim an intent and read it back.
 *
 * The claim is the API's first write on the create path: it records the spec
 * binding, the payment requirements and the EIP-3009 attribution settlement
 * recovery needs after the API's request is gone. The read is the vocabulary
 * the API polls while a payment is in flight, where `claimed` is `pending`.
 */
import type { Express, Request, Response } from "express";
import type { PaymentIntentStatus } from "@x402s/shared/protocol";
import { intentClaimSchema } from "../../control-api-schemas.js";
import { invalidRequest } from "../../routes/errors.js";
import type { ControlApiDeps } from "../types.js";

async function claimIntent(
  deps: ControlApiDeps,
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = intentClaimSchema.safeParse(req.body);
  if (!parsed.success) {
    invalidRequest(res, parsed.error.issues);
    return;
  }
  const result = await deps.store.claimPaymentIntent(
    parsed.data.paymentKey,
    parsed.data.specHash,
    parsed.data.staleMs ?? 30_000,
    {
      // Recorded so settlement recovery can describe the payment after the API
      // has forgotten the request (#31), and ask the chain about its nonce
      // instead of depending on a facilitator lookup (F-19).
      requirementsJson: parsed.data.requirements
        ? JSON.stringify(parsed.data.requirements)
        : null,
      authorizer: parsed.data.authorizer ?? null,
      settlementNonce: parsed.data.settlementNonce ?? null,
    },
  );
  if (result.status === "mismatch") {
    res.status(409).json({ status: "mismatch", error: "spec_hash_mismatch" });
    return;
  }
  if (result.status === "in_progress") {
    res.status(409).json({ status: "in_progress" });
    return;
  }
  if (result.status === "failed") {
    res.status(409).json({ status: "failed", reason: result.reason });
    return;
  }
  if (result.status === "settled") {
    res.json({ status: "settled", sessionId: result.sessionId });
    return;
  }
  res.json({
    status: "claimed",
    recovered: result.recovered,
    token: result.token,
    expiresAt: result.expiresAt,
  });
}

async function readIntent(
  deps: ControlApiDeps,
  req: Request,
  res: Response,
): Promise<void> {
  const intent = await deps.store.getPaymentIntent(String(req.params.paymentKey ?? ""));
  if (!intent) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const status: PaymentIntentStatus = {
    status: intent.status === "claimed" ? "pending" : intent.status,
    ...(intent.sessionId ? { sessionId: intent.sessionId } : {}),
    ...(intent.reason ? { reason: intent.reason } : {}),
  };
  res.json(status);
}

export function mountClaimRoutes(app: Express, deps: ControlApiDeps): void {
  app.post("/internal/payment-intents/claim", (req, res) => claimIntent(deps, req, res));
  app.get("/internal/payment-intents/:paymentKey", (req, res) => readIntent(deps, req, res));
}
