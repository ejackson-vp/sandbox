/**
 * The payer allowlist's control surface (ADR 0013).
 *
 * Authorization is the entitlement decision: the API calls it with the address
 * that signed the client commitment, never with a `from` field the request
 * merely claims. The management routes are operator actions on the same
 * admin-token surface as the ledger routes, and disabling an entry takes effect
 * on the next create: `authorize` reads the row under its lock every time.
 */
import type { Express, Request, Response } from "express";
import { log } from "@x402s/shared/runtime";
import { allowlistAuthorizeSchema, allowlistEntrySchema } from "../control-api-schemas.js";
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

  app.get("/internal/payer-allowlist", async (_req: Request, res: Response) => {
    res.json({ entries: await store.listAllowlist() });
  });

  // PUT, not POST: the address is the identity, so re-adding replaces the
  // entry and clears `disabled_at`. It is how a wallet is re-enabled.
  app.put("/internal/payer-allowlist", async (req: Request, res: Response) => {
    const parsed = allowlistEntrySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const entry = await store.upsertAllowlist(parsed.data, Date.now());
    // Never the address: the label is the operator's own handle for it.
    log.info("allowlist_entry_written", { label: entry.label, maxTier: entry.maxTier });
    res.json({ entry });
  });

  app.delete("/internal/payer-allowlist/:address", async (req: Request, res: Response) => {
    const address = String(req.params.address ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      res.status(400).json({ error: "invalid_address" });
      return;
    }
    const changed = await store.disableAllowlist(address, Date.now());
    log.info("allowlist_entry_disabled", { changed });
    res.json({ ok: true, changed });
  });
}
