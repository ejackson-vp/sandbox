/**
 * Internal control API (controller-owned).
 *
 * Reached only by the API server, over the cluster network, with a shared
 * admin token and a NetworkPolicy that permits nothing else. It is never
 * exposed through the ingress path.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  MAX_DURATION_SECONDS,
  type EntitlementRequest,
  type SandboxState,
} from "@x402s/shared";
import type { ControllerConfig } from "./config.js";
import type { Store } from "./store.js";
import type { RelayClient } from "./relay-client.js";
import { constantTimeEqual } from "./tokens.js";
import { PaymentAlreadyRedeemedError } from "./store.js";
import { log } from "./log.js";

const entitlementSchema = z.object({
  sessionId: z.string().regex(/^sbx_[0-9a-f]{24}$/),
  capabilityHash: z.string().regex(/^[0-9a-f]{64}$/),
  capabilityExpiresAt: z.number().int().positive(),
  durationSeconds: z.number().int().min(1).max(MAX_DURATION_SECONDS),
  clientPublicKey: z.string().min(40).max(64),
  clientNonce: z.string().min(40).max(64),
  payment: z.object({
    paymentKey: z.string().regex(/^[0-9a-f]{64}$/),
    network: z.string().min(3).max(64),
    scheme: z.string().min(1).max(32),
    asset: z.string().min(1).max(128),
    amount: z.string().regex(/^\d{1,30}$/),
    payTo: z.string().min(2).max(128),
    payer: z.string().min(2).max(128).optional(),
    transaction: z.string().min(1).max(256).optional(),
    mode: z.enum(["mock", "testnet"]),
  }),
});

export interface ControlApiDeps {
  cfg: ControllerConfig;
  store: Store;
  relay: RelayClient;
}

export function createControlApi(deps: ControlApiDeps): express.Express {
  const { cfg, store, relay } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  app.get("/internal/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/internal", (req: Request, res: Response, next: NextFunction) => {
    const token = req.header("x-internal-token") ?? "";
    if (!cfg.adminToken || !constantTimeEqual(token, cfg.adminToken)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });

  const describe = async (id: string) => {
    const session = store.getSession(id);
    if (!session) return null;
    let relayState;
    try {
      relayState = await relay.state(id);
    } catch {
      relayState = { registered: false, connected: false, resultAvailable: false };
    }
    const payment = store.getPayment(session.paymentKey);
    return {
      sessionId: session.id,
      state: session.state,
      durationSeconds: session.durationSeconds,
      createdAt: session.createdAt,
      paidAt: session.paidAt ?? undefined,
      readyAt: session.readyAt ?? undefined,
      executionDeadlineAt: session.executionDeadlineAt ?? undefined,
      completedAt: session.completedAt ?? undefined,
      destroyedAt: session.destroyedAt ?? undefined,
      clientNonce: session.clientNonce,
      clientPublicKey: session.clientPublicKey,
      capabilityHash: session.capabilityHash,
      capabilityExpiresAt: session.capabilityExpiresAt,
      guestPublicKey: session.guestPublicKey ?? undefined,
      attestation: session.attestationJson ? JSON.parse(session.attestationJson) : undefined,
      failureCode: session.failureCode ?? undefined,
      failureMessage: session.failureMessage ?? undefined,
      runtimeClass: session.runtimeClass ?? undefined,
      executionMode: session.executionMode ?? undefined,
      payment: {
        paymentKey: payment?.paymentKey ?? session.paymentKey,
        network: payment?.network ?? "unknown",
        scheme: payment?.scheme ?? "exact",
        asset: payment?.asset ?? "unknown",
        amount: payment?.amount ?? "0",
        payTo: payment?.payTo ?? "",
        payer: payment?.payer,
        transaction: payment?.transaction,
        mode: payment?.mode ?? "mock",
      },
      relay: {
        ...relayState,
        attestation: undefined, // never duplicate evidence here; it is in `attestation`
      },
    };
  };

  app.post("/internal/entitlements", async (req: Request, res: Response) => {
    const parsed = entitlementSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_entitlement", issues: parsed.error.issues });
      return;
    }
    const body: EntitlementRequest = parsed.data;
    const now = Date.now();
    try {
      store.createEntitlement(
        {
          paymentKey: body.payment.paymentKey,
          network: body.payment.network,
          scheme: body.payment.scheme,
          asset: body.payment.asset,
          amount: body.payment.amount,
          payTo: body.payment.payTo,
          payer: body.payment.payer,
          transaction: body.payment.transaction,
          mode: body.payment.mode,
        },
        {
          id: body.sessionId,
          capabilityHash: body.capabilityHash,
          capabilityExpiresAt: body.capabilityExpiresAt,
          clientPublicKey: body.clientPublicKey,
          clientNonce: body.clientNonce,
          durationSeconds: body.durationSeconds,
          state: "PAID" as SandboxState,
          createdAt: now,
          paidAt: now,
          readyAt: null,
          executionDeadlineAt: null,
          completedAt: null,
          destroyedAt: null,
          failureCode: null,
          failureMessage: null,
          attestationJson: null,
          guestPublicKey: null,
          paymentKey: body.payment.paymentKey,
          podName: null,
          runtimeClass: cfg.runtimeClass,
          executionMode: cfg.executionMode,
          relayTokenHash: null,
          execStartedAt: null,
          execAccepted: 0,
          resultFetchedAt: null,
          relayPurgedAt: null,
          destroyRequested: 0,
          updatedAt: now,
        },
      );
    } catch (err) {
      if (err instanceof PaymentAlreadyRedeemedError) {
        log.warn("payment_replay_rejected", { paymentKeyPrefix: body.payment.paymentKey.slice(0, 12) });
        res.status(409).json({ error: "payment_already_redeemed", message: err.message });
        return;
      }
      throw err;
    }
    log.info("entitlement_created", {
      sessionId: body.sessionId,
      durationSeconds: body.durationSeconds,
      paymentKeyPrefix: body.payment.paymentKey.slice(0, 12),
    });
    res.status(201).json({ sessionId: body.sessionId, state: "PAID" });
  });

  app.get("/internal/sessions/:id", async (req, res) => {
    const view = await describe(String(req.params.id ?? ""));
    if (!view) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(view);
  });

  app.post("/internal/sessions/:id/execute", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const { envelope } = (req.body ?? {}) as { envelope?: unknown };
    if (typeof envelope !== "string" || envelope.length === 0 || envelope.length > 1_500_000) {
      res.status(400).json({ error: "invalid_envelope" });
      return;
    }
    const session = store.getSession(id);
    if (!session) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (session.state !== "READY") {
      res.status(409).json({ error: "not_ready", state: session.state });
      return;
    }
    const deadline = session.executionDeadlineAt ?? 0;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      store.markExpired(id, "execution_window_elapsed", "execution window elapsed before payload submission");
      res.status(410).json({ error: "execution_window_elapsed", state: "EXPIRED" });
      return;
    }
    // Atomic single-execution claim: concurrent submits cannot both win.
    if (!store.claimExecution(id)) {
      res.status(409).json({ error: "already_executed", state: store.getSession(id)?.state });
      return;
    }
    try {
      await relay.deliver(id, envelope, deadline);
    } catch (err) {
      store.releaseExecution(id);
      const status = (err as { status?: number }).status;
      log.warn("execution_delivery_failed", { sessionId: id, status, error: (err as Error).message });
      res.status(409).json({ error: "guest_not_available", state: "READY" });
      return;
    }
    res.status(202).json({ state: "RUNNING", remainingMs: Math.max(0, remaining) });
  });

  app.get("/internal/sessions/:id/result", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const session = store.getSession(id);
    if (!session) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (session.state === "FAILED" || session.state === "EXPIRED") {
      res.json({ state: session.state });
      return;
    }
    if (session.state === "DESTROYED") {
      res.json({ state: "DESTROYED" });
      return;
    }
    if (session.state !== "RUNNING" && session.state !== "COMPLETED") {
      res.status(202).json({ state: session.state });
      return;
    }

    let out: { envelope: string | null };
    try {
      out = await relay.result(id, cfg.relayResultWaitMs);
    } catch (err) {
      log.warn("relay_result_failed", { sessionId: id, error: (err as Error).message });
      res.status(202).json({ state: store.getSession(id)?.state ?? session.state });
      return;
    }
    if (out.envelope) {
      store.markCompleted(id);
      store.markResultFetched(id);
      log.info("result_returned", { sessionId: id });
      res.json({ state: "COMPLETED", envelope: out.envelope });
      return;
    }
    const latest = store.getSession(id) ?? session;
    res.status(202).json({ state: latest.state });
  });

  app.delete("/internal/sessions/:id", (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const session = store.getSession(id);
    if (!session) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    store.requestDestroy(id);
    res.json({ state: store.getSession(id)?.state ?? session.state });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error("control_api_error", { error: err.message });
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
