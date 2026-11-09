import type { Express, Request, Response } from "express";
import {
  canonicalJson,
  metrics,
  resolveSessionSpec,
  specHash as computeSpecHash,
  type PaymentIntentStatus,
  type SessionSpec,
  type SessionState,
} from "@x402s/shared";
import { log } from "@x402s/shared";
import { PaymentAlreadyRedeemedError, type LedgerStatus } from "../store.js";
import { completeSchema, intentClaimSchema } from "../control-api-schemas.js";
import type { ControlApiDeps } from "./types.js";

export function registerPaymentRoutes(app: Express, deps: ControlApiDeps): void {
  const cfg = deps.cfg;
  const store = deps.store;
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

  app.post("/internal/payment-intents/:paymentKey/complete", async (req: Request, res: Response) => {
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

    const admission = await deps.capacity.attach(paymentKey, body.sessionId, expectedHash, spec);
    if (!admission.admitted) {
      res.status(409).json({
        error: "capacity_unavailable",
        retryable: admission.retryable,
        requested: admission.requested,
      });
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
          clientSigner: body.clientSigner ?? null,
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
      deps.capacity.releaseSession?.(body.sessionId);
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

  /* ---------------- payment ledger ---------------- */

  app.get("/internal/payments", (req: Request, res: Response) => {
    const status = String(req.query.status ?? "REFUND_PENDING");
    if (status !== "SETTLED" && status !== "REFUND_PENDING" && status !== "REFUNDED") {
      res.status(400).json({ error: "invalid_status" });
      return;
    }
    res.json({ payments: store.listLedgerByStatus(status as LedgerStatus) });
  });

  app.get("/internal/payments/:paymentKey", (req: Request, res: Response) => {
    const ledger = store.getLedgerByPayment(String(req.params.paymentKey ?? ""));
    if (!ledger) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(ledger);
  });

  app.post("/internal/payments/:paymentKey/refund", (req: Request, res: Response) => {
    const paymentKey = String(req.params.paymentKey ?? "");
    const transaction = typeof req.body?.transaction === "string" ? req.body.transaction : "";
    if (!transaction) {
      res.status(400).json({ error: "transaction_required" });
      return;
    }
    const ledger = store.getLedgerByPayment(paymentKey);
    if (!ledger) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const session = store.getSession(ledger.sessionId);
    if (ledger.status === "SETTLED" && session && session.readyAt !== null) {
      res.status(409).json({ error: "service_delivered", message: "the session reached READY; manual refund requires review" });
      return;
    }
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "manual_refund";
    const changed = store.markRefunded(paymentKey, transaction, reason);
    res.json({ ok: true, changed, payment: store.getLedgerByPayment(paymentKey) });
  });

  /* ---------------- sessions ---------------- */

}
