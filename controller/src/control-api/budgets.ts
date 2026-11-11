/**
 * Durable budget reservation (#48).
 *
 * Called by the API after the client commitment is verified (so `payer` is a key
 * the requester provably controls) and before any capacity hold, intent claim or
 * settlement. A rejection is a decided answer, not an error, so this always
 * answers 200 with the decision; the transport failing is the only 5xx.
 */
import type { Express, Request, Response } from "express";
import { metrics } from "@x402s/shared/runtime";
import { budgetReserveSchema } from "../control-api-schemas.js";
import type { BudgetLimits } from "../store/budgets.js";
import type { ControlApiDeps } from "./types.js";

export function budgetLimitsFrom(cfg: ControlApiDeps["cfg"]): BudgetLimits {
  return {
    windowMs: cfg.budgetWindowMs,
    payerCreates: cfg.payerCreatesPerWindow,
    payerSpend: cfg.payerSpendPerWindow,
    payerConcurrent: cfg.payerConcurrentSessions,
    globalCreates: cfg.globalCreatesPerWindow,
    globalConcurrent: cfg.globalConcurrentSessions,
  };
}

export function registerBudgetRoutes(app: Express, deps: ControlApiDeps): void {
  const limits = budgetLimitsFrom(deps.cfg);

  app.post("/internal/budgets/reserve", (req: Request, res: Response) => {
    const parsed = budgetReserveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const decision = deps.store.reserveBudgets(
      parsed.data.payer ?? null,
      parsed.data.amount,
      limits,
    );
    if (!decision.ok) {
      // Bounded label: the scope, never the payer or the amount.
      metrics
        .counter("sandbox_budget_rejections_total", "Create-budget rejections by scope")
        .inc({ scope: decision.scope });
    }
    res.json(decision);
  });
}
