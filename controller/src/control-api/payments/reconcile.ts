/**
 * The two money-recovery writes: fail an intent, refund a ledger row.
 *
 * `/fail` records that settlement was refused. It is refused when the ledger
 * already says the customer was served: the money moved, so the recovery is a
 * refund, never a retry of this route.
 *
 * `/refund` is the operator or facilitator path for a settled payment that
 * produced no session, or one that never reached READY. `:paymentKey` may be a
 * payment key or an EIP-3009 nonce; both identify at most one ledger row.
 */
import type { Express, Request, Response } from "express";
import { log } from "@x402s/shared/runtime";
import { LedgerSettledError } from "../../store/models/money.js";
import type { ControlApiDeps } from "../types.js";

async function failIntent(
  deps: ControlApiDeps,
  req: Request,
  res: Response,
): Promise<void> {
  const paymentKey = String(req.params.paymentKey ?? "");
  const reason = String((req.body ?? {}).reason ?? "settlement_failed");
  try {
    await deps.store.failPaymentIntent(paymentKey, reason);
  } catch (err) {
    if (err instanceof LedgerSettledError) {
      res.status(409).json({
        error: "ledger_settled",
        ledgerStatus: "SETTLED",
        message: err.message,
      });
      return;
    }
    throw err;
  }
  log.warn("payment_intent_failed", { reason });
  res.json({ ok: true });
}

async function refundPayment(
  deps: ControlApiDeps,
  req: Request,
  res: Response,
): Promise<void> {
  // `:paymentKey` may be a payment key or an EIP-3009 nonce; both identify at
  // most one ledger row.
  const identifier = String(req.params.paymentKey ?? "");
  const byNonce = /^0x[0-9a-fA-F]{64}$/.test(identifier);
  const paymentKey = byNonce
    ? (await deps.store.getLedgerByNonce(identifier.toLowerCase()))?.paymentKey ?? ""
    : identifier;
  const transaction = typeof req.body?.transaction === "string" ? req.body.transaction : "";
  if (!transaction) {
    res.status(400).json({ error: "transaction_required" });
    return;
  }
  const ledger = await deps.store.getLedgerByPayment(paymentKey);
  if (!ledger) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const session = await deps.store.getSession(ledger.sessionId);
  if (ledger.status === "SETTLED" && session && session.readyAt !== null) {
    res.status(409).json({
      error: "service_delivered",
      message: "the session reached READY; manual refund requires review",
    });
    return;
  }
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "manual_refund";
  const changed = await deps.store.markRefunded(paymentKey, transaction, reason);
  res.json({ ok: true, changed, payment: await deps.store.getLedgerByPayment(paymentKey) });
}

export function mountReconcileRoutes(app: Express, deps: ControlApiDeps): void {
  app.post("/internal/payment-intents/:paymentKey/fail", (req, res) => failIntent(deps, req, res));
  app.post("/internal/payments/:paymentKey/refund", (req, res) => refundPayment(deps, req, res));
}
