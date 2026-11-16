/**
 * The create kill switch's control surface (schema v21).
 *
 * Same admin-token surface as the ledger and allowlist routes: there is no new
 * credential, and these routes are not reachable except from inside the cluster.
 * The row lives in the controller's database and the API reads it over
 * `/internal/create-switch` before any payment or capacity work, so this is the
 * only writer and the only source of truth.
 *
 * The answer is the state, not "ok": an operator who just enabled the switch
 * should see the effective flag, the expiry and the reason they typed, so a
 * mistake is visible in the same round trip.
 */
import type { Express, Request, Response } from "express";
import { log, metrics, publishCreateSwitch } from "@x402s/shared/runtime";
import { createSwitchDisableSchema, createSwitchEnableSchema } from "../control-api-schemas.js";
import { invalidRequest } from "../routes/errors.js";
import type { CreateSwitchState } from "../store/models/admin.js";
import type { ControlApiDeps } from "./types.js";

/** Publish the gauge here too, so an operator sees the flip without create traffic. */
function observe(state: CreateSwitchState): void {
  publishCreateSwitch(metrics, state.enabled);
}

export function registerCreateSwitchRoutes(app: Express, deps: ControlApiDeps): void {
  const store = deps.store;

  // codeql[js/missing-rate-limiting] bounded by the TokenBucket middleware mounted on /internal (control-api.ts:120); CodeQL models only third-party limiter packages (security-review/FINDINGS.md F-16).
  app.get("/internal/create-switch", async (_req: Request, res: Response) => {
    const state = await store.readCreateSwitch(Date.now());
    observe(state);
    res.json({ switch: state });
  });

  // This is the whole emergency stop: one row write, effective on the next
  // create, and it touches no session.
  // codeql[js/missing-rate-limiting] bounded by the TokenBucket middleware mounted on /internal (control-api.ts:120); CodeQL models only third-party limiter packages (security-review/FINDINGS.md F-16).
  app.put("/internal/create-switch", async (req: Request, res: Response) => {
    const parsed = createSwitchEnableSchema.safeParse(req.body);
    if (!parsed.success) {
      invalidRequest(res, parsed.error.issues);
      return;
    }
    const until = parsed.data.until ? Date.parse(parsed.data.until) : null;
    const written = await store.writeCreateSwitch(
      {
        enabled: true,
        reason: parsed.data.reason,
        actor: parsed.data.actor,
        until,
      },
      Date.now(),
    );
    if (!written.ok) {
      res.status(400).json({
        error: written.reason,
        message: "--until must be in the future; nothing was changed",
      });
      return;
    }
    observe(written.state);
    // The actor and the reason are the row's audit trail, not log fields: one
    // is free text and the other is a name, and neither belongs in a log line
    // that a broader audience reads.
    log.info("create_switch_enabled", { expiresAt: written.state.expiresAt });
    res.json({ switch: written.state });
  });

  // codeql[js/missing-rate-limiting] bounded by the TokenBucket middleware mounted on /internal (control-api.ts:120); CodeQL models only third-party limiter packages (security-review/FINDINGS.md F-16).
  app.delete("/internal/create-switch", async (req: Request, res: Response) => {
    const parsed = createSwitchDisableSchema.safeParse(req.body);
    if (!parsed.success) {
      invalidRequest(res, parsed.error.issues);
      return;
    }
    const written = await store.writeCreateSwitch(
      {
        enabled: false,
        reason: "creates re-enabled by an operator",
        actor: parsed.data.actor,
        until: null,
      },
      Date.now(),
    );
    if (!written.ok) {
      // Unreachable: a disable has no `until`. Kept so the branch cannot be
      // silently dropped if the write contract widens.
      res.status(400).json({ error: written.reason });
      return;
    }
    observe(written.state);
    log.info("create_switch_disabled");
    res.json({ switch: written.state });
  });
}
