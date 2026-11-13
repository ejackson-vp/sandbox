/**
 * The payer allowlist's entitlement decision (ADR 0013).
 *
 * The API calls this with the address that signed the client commitment, never
 * with a `from` field the request merely claims. Operator management routes
 * (list, add, disable) live in the same module and are added with the CLI.
 */
import type { Express, Request, Response } from "express";
import { log } from "@x402s/shared/runtime";
import { allowlistAuthorizeSchema } from "../control-api-schemas.js";
import type { ControlApiDeps } from "./types.js";

export function registerAllowlistRoutes(app: Express, deps: ControlApiDeps): void {
  const store = deps.store;

  app.post("/internal/payer-allowlist/authorize", async (req: Request, res: Response) => {
    const parsed = allowlistAuthorizeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const decision = await store.authorizeAllowlistedPayer(parsed.data.address, parsed.data.tier);
    if (!decision.allowed && decision.reason !== "not_allowlisted") {
      // Bounded, address-free label: the address itself is customer identity.
      log.info("allowlist_refused", { reason: decision.reason });
    }
    res.json(decision);
  });
}
