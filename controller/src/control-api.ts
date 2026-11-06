/**
 * Internal control API (controller-owned).
 *
 * Reached only by the API server, over the cluster network, with a shared
 * admin token and a NetworkPolicy that permits nothing else. It is never
 * exposed through the ingress path.
 *
 * All customer payloads here are opaque sealed-box envelopes; commands, file
 * contents and results never appear in this process.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  LATENCY_BUCKETS,
  MAX_LEASE_SECONDS,
  metrics,
  canonicalJson,
  resolveSessionSpec,
  specHash as computeSpecHash,
  type PaymentIntentStatus,
  type SessionSpec,
  type SessionState,
} from "@x402s/shared";
import type { ControllerConfig } from "./config.js";
import type { Store } from "./store.js";
import type { RelayClient } from "./relay-client.js";
import { constantTimeEqual } from "./tokens.js";

const OP_LABELS = new Set(["exec", "file.put", "file.get", "file.list", "file.stat"]);
function opLabel(op: string | undefined): string {
  return op && OP_LABELS.has(op) ? op : "other";
}
import { PaymentAlreadyRedeemedError } from "./store.js";
import { LifecycleError } from "./reconciler.js";
import { log } from "./log.js";

const sessionIdPattern = /^sbx_[0-9a-f]{24}$/;

const intentClaimSchema = z.object({
  paymentKey: z.string().regex(/^[0-9a-f]{64}$/),
  specHash: z.string().regex(/^[0-9a-f]{64}$/),
  staleMs: z.number().int().min(1000).max(600_000).optional(),
});

const idlePolicySchema = z.object({
  maxIdleSeconds: z.number().int().min(1).max(28800).optional(),
  suspendedDurationSeconds: z.number().int().min(1).max(28800).optional(),
  autoResume: z.boolean().optional(),
});

const specSchema = z.object({
  tier: z.enum(["short", "standard", "extended", "long", "custom"]),
  durationSeconds: z.number().int().min(1).max(MAX_LEASE_SECONDS),
  idlePolicy: idlePolicySchema.optional(),
  maxLifetimeSeconds: z.number().int().min(1).max(28800).optional(),
  baseline: z
    .object({
      cpuMillis: z.number().int().min(50),
      memoryMiB: z.number().int().min(64),
    })
    .optional(),
  limits: z.object({
    cpuMillis: z.number().int().positive(),
    memoryMiB: z.number().int().positive(),
    diskMiB: z.number().int().positive(),
    maxOutputBytes: z.number().int().positive(),
    maxFileBytes: z.number().int().positive(),
    maxCommandSeconds: z.number().int().positive(),
    maxProcesses: z.number().int().positive(),
  }),
});

const timingsSchema = z
  .object({
    apiReceivedAt: z.number().int().optional(),
    paymentVerifyMs: z.number().nonnegative().max(600_000).optional(),
    paymentSettleMs: z.number().nonnegative().max(600_000).optional(),
    entitlementMs: z.number().nonnegative().max(600_000).optional(),
  })
  .optional();

const completeSchema = z.object({
  sessionId: z.string().regex(sessionIdPattern),
  capabilityHash: z.string().regex(/^[0-9a-f]{64}$/),
  capabilityExpiresAt: z.number().int().positive(),
  spec: specSchema,
  clientPublicKey: z.string().min(40).max(64),
  clientNonce: z.string().min(40).max(64),
  timings: timingsSchema,
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

const operationSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  envelope: z.string().min(1).max(16 * 1024 * 1024),
  op: z.string().min(1).max(32).optional(),
  waitMs: z.number().int().min(0).max(120_000).optional(),
});

export interface ControlApiDeps {
  cfg: ControllerConfig;
  store: Store;
  relay: RelayClient;
  /** Optional event-driven nudge (the reconciler is not started in unit tests). */
  wake?: () => void;
  /** Optional lifecycle actions (the reconciler owns them). */
  suspend?: (id: string) => Promise<void>;
  resume?: (id: string) => Promise<void>;
}

export function createControlApi(deps: ControlApiDeps): express.Express {
  const { cfg, store, relay } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32mb" }));

  app.get("/internal/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/internal/wake", (req, res) => {
    // The relay holds only this token; it can nudge the reconciler but cannot
    // reach any other internal endpoint.
    const token = req.header("x-wake-token") ?? req.header("x-internal-token") ?? "";
    // The API holds the admin token; the relay holds only the wake token.
    const authorized =
      (Boolean(cfg.wakeToken) && constantTimeEqual(token, cfg.wakeToken)) ||
      (Boolean(cfg.adminToken) && constantTimeEqual(token, cfg.adminToken));
    if (!authorized) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    deps.wake?.();
    res.status(202).json({ ok: true });
  });

  // Aggregate metrics only (no session ids, no payloads). Scraped internally.
  app.get("/metrics", (_req, res) => {
    res.setHeader("content-type", "text/plain; version=0.0.4");
    res.send(metrics.render());
  });

  app.use("/internal", (req: Request, res: Response, next: NextFunction) => {
    const token = req.header("x-internal-token") ?? "";
    if (!cfg.adminToken || !constantTimeEqual(token, cfg.adminToken)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });

  const describe = (id: string) => {
    const session = store.getSession(id);
    if (!session) return null;
    const payment = store.getPayment(session.paymentKey);
    const now = Date.now();
    const remainingSeconds =
      session.leaseExpiresAt === null ? 0 : Math.max(0, Math.floor((session.leaseExpiresAt - now) / 1000));
    return {
      sessionId: session.id,
      state: session.state,
      tier: session.tier,
      durationSeconds: session.durationSeconds,
      limits: session.limits,
      createdAt: session.createdAt,
      paidAt: session.paidAt ?? undefined,
      readyAt: session.readyAt ?? undefined,
      leaseExpiresAt: session.leaseExpiresAt ?? undefined,
      remainingSeconds,
      terminatingAt: session.terminatingAt ?? undefined,
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
      busy: session.activeRequestId !== null,
      suspendedAt: session.suspendedAt ?? undefined,
      resumeCount: session.resumeCount,
      maxLifetimeSeconds: session.maxLifetimeSeconds ?? undefined,
      idlePolicy: session.idlePolicyJson ? JSON.parse(session.idlePolicyJson) : undefined,
      baseline:
        session.baselineCpuMillis && session.baselineMemoryMib
          ? { cpuMillis: session.baselineCpuMillis, memoryMiB: session.baselineMemoryMib }
          : undefined,
      timings: session.timingsJson ? JSON.parse(session.timingsJson) : undefined,
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
    };
  };

  /* ---------------- payment intent outbox ---------------- */

  app.post("/internal/payment-intents/claim", (req: Request, res: Response) => {
    const parsed = intentClaimSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const result = store.claimPaymentIntent(
      parsed.data.paymentKey,
      parsed.data.specHash,
      parsed.data.staleMs ?? 30_000,
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
    res.json({ status: "claimed", recovered: result.recovered });
  });

  app.get("/internal/payment-intents/:paymentKey", (req: Request, res: Response) => {
    const intent = store.getPaymentIntent(String(req.params.paymentKey ?? ""));
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
  });

  app.post("/internal/payment-intents/:paymentKey/complete", (req: Request, res: Response) => {
    const paymentKey = String(req.params.paymentKey ?? "");
    const parsed = completeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    const intent = store.getPaymentIntent(paymentKey);
    if (!intent) {
      res.status(409).json({ error: "intent_not_claimed" });
      return;
    }
    if (intent.status === "settled") {
      res.json({ sessionId: intent.sessionId, state: "PAID" });
      return;
    }
    if (body.payment.paymentKey !== paymentKey) {
      res.status(400).json({ error: "payment_key_mismatch" });
      return;
    }

    // Re-validate the spec against this controller's policy, and bind it to the
    // hash that was used at payment time.
    const resolution = resolveSessionSpec(
      {
        tier: body.spec.tier,
        durationSeconds: body.spec.durationSeconds,
        cpuMillis: body.spec.limits.cpuMillis,
        memoryMiB: body.spec.limits.memoryMiB,
        diskMiB: body.spec.limits.diskMiB,
        clientPublicKey: body.clientPublicKey,
        clientNonce: body.clientNonce,
        ...(body.spec.idlePolicy ? { idlePolicy: body.spec.idlePolicy } : {}),
        ...(body.spec.maxLifetimeSeconds !== undefined
          ? { maxLifetimeSeconds: body.spec.maxLifetimeSeconds }
          : {}),
        ...(body.spec.baseline
          ? {
              baselineCpuMillis: body.spec.baseline.cpuMillis,
              baselineMemoryMiB: body.spec.baseline.memoryMiB,
            }
          : {}),
      },
      cfg.tiers,
      cfg.platformLimits,
    );
    if (!resolution.ok) {
      res.status(400).json({ error: resolution.code, message: resolution.message });
      return;
    }
    const spec: SessionSpec = body.spec;
    if (canonicalJson(resolution.spec) !== canonicalJson(spec)) {
      res.status(400).json({ error: "spec_not_allowed", message: "requested limits are not permitted" });
      return;
    }
    const expectedHash = computeSpecHash(spec);
    if (intent.specHash !== expectedHash || expectedHash !== computeSpecHash(resolution.spec)) {
      res.status(409).json({ error: "spec_hash_mismatch" });
      return;
    }

    const now = Date.now();
    try {
      store.completeEntitlement(
        paymentKey,
        {
          paymentKey,
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
          tier: spec.tier,
          durationSeconds: spec.durationSeconds,
          limits: spec.limits,
          state: "PAID" as SessionState,
          createdAt: now,
          paidAt: now,
          readyAt: null,
          leaseExpiresAt: null,
          terminatingAt: null,
          destroyedAt: null,
          terminationReason: null,
          failureCode: null,
          failureMessage: null,
          attestationJson: null,
          guestPublicKey: null,
          paymentKey,
          podName: null,
          runtimeClass: cfg.runtimeClass,
          executionMode: cfg.executionMode,
          relayTokenHash: null,
          activeRequestId: null,
          relayPurgedAt: null,
          destroyRequested: 0,
          timingsJson: null,
          idlePolicyJson: spec.idlePolicy ? JSON.stringify(spec.idlePolicy) : null,
          maxLifetimeSeconds: spec.maxLifetimeSeconds ?? null,
          baselineCpuMillis: spec.baseline?.cpuMillis ?? null,
          baselineMemoryMib: spec.baseline?.memoryMiB ?? null,
          nodeName: null,
          suspendedAt: null,
          resumeCount: 0,
          lastActivityAt: null,
          workspacePvc: null,
          updatedAt: now,
        },
      );
      if (body.timings) {
        store.mergeTimings(body.sessionId, body.timings);
      }
      metrics.counter("sandbox_sessions_created_total", "Entitlements created").inc({
        tier: spec.tier,
      });
    } catch (err) {
      if (err instanceof PaymentAlreadyRedeemedError) {
        const existing = store.getPaymentIntent(paymentKey);
        res.status(409).json({ error: "payment_already_redeemed", sessionId: existing?.sessionId });
        return;
      }
      throw err;
    }
    log.info("entitlement_created", {
      sessionId: body.sessionId,
      tier: spec.tier,
      durationSeconds: spec.durationSeconds,
      paymentKeyPrefix: paymentKey.slice(0, 12),
    });
    res.status(201).json({ sessionId: body.sessionId, state: "PAID" });
  });

  app.post("/internal/payment-intents/:paymentKey/fail", (req: Request, res: Response) => {
    const reason = String((req.body ?? {}).reason ?? "settlement_failed");
    store.failPaymentIntent(String(req.params.paymentKey ?? ""), reason);
    log.warn("payment_intent_failed", { reason });
    res.json({ ok: true });
  });

  /* ---------------- sessions ---------------- */

  app.get("/internal/sessions/:id", (req: Request, res: Response) => {
    const view = describe(String(req.params.id ?? ""));
    if (!view) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(view);
  });

  app.post("/internal/sessions/:id/suspend", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    if (!deps.suspend) {
      res.status(501).json({ error: "not_supported" });
      return;
    }
    try {
      await deps.suspend(id);
      const view = describe(id);
      if (!view) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(view);
    } catch (err) {
      if (err instanceof LifecycleError) {
        res.status(err.status).json({ error: err.code, message: err.message });
        return;
      }
      res.status(500).json({ error: "suspend_failed", message: (err as Error).message });
    }
  });

  app.post("/internal/sessions/:id/resume", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    if (!deps.resume) {
      res.status(501).json({ error: "not_supported" });
      return;
    }
    try {
      await deps.resume(id);
      const view = describe(id);
      if (!view) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.status(202).json(view);
    } catch (err) {
      if (err instanceof LifecycleError) {
        res.status(err.status).json({ error: err.code, message: err.message });
        return;
      }
      res.status(500).json({ error: "resume_failed", message: (err as Error).message });
    }
  });

  app.post("/internal/sessions/:id/operations", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const parsed = operationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const { requestId, envelope, op } = parsed.data;
    const operationStarted = Date.now();
    res.on("finish", () => {
      const label = opLabel(op);
      metrics
        .histogram("sandbox_exec_duration_seconds", "Operation duration (controller view)", LATENCY_BUCKETS)
        .observe((Date.now() - operationStarted) / 1000, { op: label });
      metrics
        .counter("sandbox_exec_total", "Operations by result")
        .inc({ op: label, result: res.statusCode < 300 ? (res.statusCode === 202 ? "pending" : "ok") : "error" });
    });

    const session = store.getSession(id);
    if (!session) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (session.state !== "SUSPENDED") store.touchActivity(id);
    const claim = store.claimOperation(id, requestId, op ?? "operation");
    if (!claim.ok) {
      if (claim.code === "duplicate") {
        // Idempotent retry: return the (possibly still pending) response.
        const existing = await relay.response(id, requestId, parsed.data.waitMs ?? 1000).catch(() => ({ kind: "pending" as const }));
        if (existing.kind === "envelope") {
          res.json({ state: store.getSession(id)?.state ?? session.state, requestId, envelope: existing.envelope });
          return;
        }
        res.status(202).json({ state: store.getSession(id)?.state ?? session.state, requestId, pending: true });
        return;
      }
      if (claim.code === "busy") {
        res.status(409).json({
          error: "busy",
          state: claim.state,
          requestId: claim.requestId,
          message: "another operation is already running in this session",
        });
        return;
      }
      if (claim.code === "lease_expired") {
        store.requestTermination(id, "lease_expired");
        res.status(410).json({
          error: "lease_expired",
          state: "TERMINATING",
          message: "the session lease has ended",
        });
        return;
      }
      res.status(409).json({
        error: "session_not_usable",
        state: claim.state,
        message: `the session is not accepting operations (state ${claim.state})`,
      });
      return;
    }

    const leaseDeadline = session.leaseExpiresAt ?? Date.now();
    const deadline = Math.min(leaseDeadline + 1000, Date.now() + 10 * 60_000);
    try {
      await relay.request(id, requestId, envelope, deadline);
    } catch (err) {
      store.finishOperation(id, requestId, "abandoned");
      const status = (err as { status?: number }).status;
      log.warn("operation_delivery_failed", { sessionId: id, requestId, status, error: (err as Error).message });
      res.status(409).json({ error: "guest_not_available", state: store.getSession(id)?.state });
      return;
    }

    const waitMs = Math.max(
      0,
      Math.min(
        parsed.data.waitMs ?? cfg.relayResponseWaitMs,
        Math.max(0, leaseDeadline - Date.now()) + 1000,
      ),
    );
    let outcome;
    try {
      outcome = await relay.response(id, requestId, waitMs);
    } catch (err) {
      log.warn("operation_response_failed", { sessionId: id, requestId, error: (err as Error).message });
      res.status(202).json({ state: store.getSession(id)?.state, requestId, pending: true });
      return;
    }
    if (outcome.kind === "envelope") {
      store.finishOperation(id, requestId, "done");
      res.json({ state: store.getSession(id)?.state, requestId, envelope: outcome.envelope });
      return;
    }
    if (outcome.kind === "guest_error") {
      store.finishOperation(id, requestId, "error");
      res.status(502).json({ error: "guest_error", message: outcome.message, requestId });
      return;
    }
    res.status(202).json({ state: store.getSession(id)?.state, requestId, pending: true });
  });

  app.get("/internal/sessions/:id/operations/:requestId", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const requestId = String(req.params.requestId ?? "");
    const record = store.getExecRequest(id, requestId);
    if (!record) {
      res.status(404).json({ error: "request_not_found" });
      return;
    }
    const waitMs = Math.min(120_000, Number(req.query.waitMs) || 20_000);
    try {
      const outcome = await relay.response(id, requestId, waitMs);
      if (outcome.kind === "envelope") {
        if (record.state === "pending") store.finishOperation(id, requestId, "done");
        res.json({ state: store.getSession(id)?.state, requestId, envelope: outcome.envelope });
        return;
      }
      if (outcome.kind === "guest_error") {
        res.status(502).json({ error: "guest_error", message: outcome.message, requestId });
        return;
      }
    } catch {
      /* fall through to pending/expired */
    }
    if (record.state === "pending") {
      res.status(202).json({ state: store.getSession(id)?.state, requestId, pending: true });
      return;
    }
    res.status(410).json({ error: "result_expired", requestId });
  });

  app.delete("/internal/sessions/:id/operations/:requestId", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const requestId = String(req.params.requestId ?? "");
    const record = store.getExecRequest(id, requestId);
    if (!record) {
      res.status(404).json({ error: "request_not_found" });
      return;
    }
    try {
      await relay.cancel(id, requestId);
    } catch (err) {
      log.warn("cancel_failed", { sessionId: id, requestId, error: (err as Error).message });
    }
    res.status(202).json({ ok: true, requestId });
  });

  app.delete("/internal/sessions/:id", (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const session = store.getSession(id);
    if (!session) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    store.requestDestroy(id);
    deps.wake?.();
    log.info("session_destroy_requested", { sessionId: id, state: session.state });
    res.json({ state: store.getSession(id)?.state ?? session.state });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error("control_api_error", { error: err.message });
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}

