/**
 * Ledger reads: list by status, by EIP-3009 nonce, by payment key.
 *
 * The nonce lookup exists because a facilitator webhook or an operator can key a
 * refund by the authorisation nonce instead of the payment key (#31). It only
 * accepts a whole nonce: a partial one is not a lookup, it is a typo.
 */
import type { Express, Request, Response } from "express";
import type { LedgerStatus } from "../../store/models/money.js";
import type { ControlApiDeps } from "../types.js";

async function listPayments(
  deps: ControlApiDeps,
  req: Request,
  res: Response,
): Promise<void> {
  const status = String(req.query.status ?? "REFUND_PENDING");
  // `REFUND_SENDING` is listable on purpose: a row there is either in flight or
  // waiting for its claim lease to expire, and an operator needs to see it.
  if (
    status !== "SETTLED" &&
    status !== "REFUND_PENDING" &&
    status !== "REFUND_SENDING" &&
    status !== "REFUNDED"
  ) {
    res.status(400).json({ error: "invalid_status" });
    return;
  }
  res.json({ payments: await deps.store.listLedgerByStatus(status as LedgerStatus) });
}

async function paymentByNonce(
  deps: ControlApiDeps,
  req: Request,
  res: Response,
): Promise<void> {
  const nonce = String(req.params.nonce ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(nonce)) {
    res.status(400).json({ error: "invalid_nonce" });
    return;
  }
  const ledger = await deps.store.getLedgerByNonce(nonce);
  if (!ledger) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(ledger);
}

async function paymentByKey(
  deps: ControlApiDeps,
  req: Request,
  res: Response,
): Promise<void> {
  const ledger = await deps.store.getLedgerByPayment(String(req.params.paymentKey ?? ""));
  if (!ledger) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(ledger);
}

export function mountReadRoutes(app: Express, deps: ControlApiDeps): void {
  app.get("/internal/payments", (req, res) => listPayments(deps, req, res));
  app.get("/internal/payments/by-nonce/:nonce", (req, res) => paymentByNonce(deps, req, res));
  app.get("/internal/payments/:paymentKey", (req, res) => paymentByKey(deps, req, res));
}
