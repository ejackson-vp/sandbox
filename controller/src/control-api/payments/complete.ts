/**
 * `/complete`: a settled payment becomes a session, exactly once.
 *
 * This is the controller half of the create critical path. It re-validates the
 * spec against this process's policy, binds it to the hash that was used at
 * payment time, takes the capacity reservation, then asks the store to write the
 * payment, the session and the settlement in one transaction.
 *
 * The answers are a closed set: a spec refusal, an admission refusal, a create,
 * an idempotent replay, a duplicate entitlement, an already-redeemed payment, or
 * a claim that moved while the request was in flight. Each one is named here so
 * the wire shape can be reviewed without reading the store.
 */
import type { Express, Request, Response } from "express";
import { canonicalJson } from "@x402s/shared/crypto";
import { resolveSessionSpec, specHash as computeSpecHash } from "@x402s/shared/payment";
import type { SessionSpec } from "@x402s/shared/protocol";
import { DEFAULT_RUNTIME } from "@x402s/shared/runtimes";
import { log, metrics } from "@x402s/shared/runtime";
import { isHeldBy } from "@x402s/shared/durable";
import type { z } from "zod";
import {
  DuplicateEntitlementError,
  PaymentAlreadyRedeemedError,
  PaymentClaimLostError,
  type PaymentRecord,
} from "../../store/models/money.js";
import { SessionRecord } from "../../store/models/session.js";
import { completeSchema } from "../../control-api-schemas.js";
import { invalidRequest } from "../../routes/errors.js";
import type { ControlApiDeps } from "../types.js";
import { completionResponse } from "./respond.js";

type CompleteBody = z.infer<typeof completeSchema>;

/**
 * The spec this controller would have priced, bound to the hash the intent was
 * claimed with. A refusal is a value, not a throw: each one is a different HTTP
 * answer the API already handles.
 */
type BoundSpec =
  | { ok: true; spec: SessionSpec; expectedHash: string }
  | { ok: false; status: number; body: Record<string, unknown> };

function bindSpec(
  body: CompleteBody,
  intentSpecHash: string,
  deps: ControlApiDeps,
): BoundSpec {
  const resolution = resolveSessionSpec(
    {
      tier: body.spec.tier,
      runtime: body.spec.runtime,
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
    deps.cfg.tiers,
    deps.cfg.platformLimits,
  );
  if (!resolution.ok) {
    return { ok: false, status: 400, body: { error: resolution.code, message: resolution.message } };
  }
  // Normalise an older API that did not send `runtime`: the spec and its hash
  // must describe the same base session the API priced.
  const spec: SessionSpec = { ...body.spec, runtime: body.spec.runtime ?? DEFAULT_RUNTIME };
  if (canonicalJson(resolution.spec) !== canonicalJson(spec)) {
    return {
      ok: false,
      status: 400,
      body: { error: "spec_not_allowed", message: "requested limits are not permitted" },
    };
  }
  const expectedHash = computeSpecHash(spec);
  if (intentSpecHash !== expectedHash || expectedHash !== computeSpecHash(resolution.spec)) {
    return { ok: false, status: 409, body: { error: "spec_hash_mismatch" } };
  }
  return { ok: true, spec, expectedHash };
}

/** The settled payment as the ledger and the refund audit read it. */
function paymentRecord(paymentKey: string, body: CompleteBody): PaymentRecord {
  return {
    paymentKey,
    network: body.payment.network,
    scheme: body.payment.scheme,
    asset: body.payment.asset,
    amount: body.payment.amount,
    payTo: body.payment.payTo,
    payer: body.payment.payer,
    transaction: body.payment.transaction,
    mode: body.payment.mode,
    settlementNonce: body.payment.settlementNonce ?? null,
    source: body.payment.source ?? "x402",
    ...(body.payment.label ? { label: body.payment.label } : {}),
    ...(body.payment.budgetKey ? { budgetKey: body.payment.budgetKey } : {}),
  };
}

/** The fresh entitlement row, with every initial value owned by the model. */
function paidSession(
  deps: ControlApiDeps,
  paymentKey: string,
  body: CompleteBody,
  spec: SessionSpec,
  now: number,
): SessionRecord {
  return SessionRecord.newPaidEntitlement({
    id: body.sessionId,
    paymentKey,
    capabilityHash: body.capabilityHash,
    capabilityExpiresAt: body.capabilityExpiresAt,
    clientPublicKey: body.clientPublicKey,
    clientNonce: body.clientNonce,
    clientSigner: body.clientSigner ?? null,
    tier: spec.tier,
    durationSeconds: spec.durationSeconds,
    limits: spec.limits,
    runtime: spec.runtime,
    runtimeClass: deps.cfg.runtimeClass,
    executionMode: deps.cfg.executionMode,
    now,
    idlePolicy: spec.idlePolicy ?? null,
    maxLifetimeSeconds: spec.maxLifetimeSeconds ?? null,
    baseline: spec.baseline ?? null,
  });
}

/**
 * What the settlement transaction did, including the races it lost. A claim
 * that moved to a worker which settled the intent is a completion with
 * `created: false`, not a refusal.
 */
type Settlement =
  | { kind: "created"; sessionId: string }
  | { kind: "idempotent"; sessionId: string }
  | { kind: "duplicate"; sessionId: string }
  | { kind: "already_redeemed"; sessionId: string | undefined }
  /** The claim moved, but the worker that took it had already settled. */
  | { kind: "recovered"; sessionId: string }
  | { kind: "stale_claim" };

/** Map one failed settlement to the answer the caller already understands. */
async function settlementFailure(
  deps: ControlApiDeps,
  paymentKey: string,
  body: CompleteBody,
  err: unknown,
): Promise<Settlement> {
  if (err instanceof PaymentAlreadyRedeemedError) {
    const existing = await deps.store.getPaymentIntent(paymentKey);
    return { kind: "already_redeemed", sessionId: existing?.sessionId ?? undefined };
  }
  if (err instanceof DuplicateEntitlementError) {
    // The second payment was recorded and marked refundable in the same
    // transaction; the client must not retry it.
    return { kind: "duplicate", sessionId: err.existingSessionId };
  }
  if (err instanceof PaymentClaimLostError) {
    // The claim was reclaimed while this request was in flight. Do not free
    // capacity here: the live owner holds the same payment reservation, and
    // releasing it would hand that owner's capacity to another create. If the
    // owner has already settled, `settle` points the row back at its session;
    // if it never does, the allocation grace expires the row.
    const current = await deps.store.getPaymentIntent(paymentKey);
    if (current?.status === "settled" && current.sessionId) {
      return { kind: "recovered", sessionId: current.sessionId };
    }
    return { kind: "stale_claim" };
  }
  // Nothing committed: the settlement transaction rolled back, so this request
  // still owns the reservation it took before settling. Best effort, exactly as
  // before: the reservation may not exist, and a failure to release it must not
  // replace the error being reported.
  await deps.capacity.releaseSession(body.sessionId).catch(() => false);
  throw err;
}

/**
 * The settlement's own bookkeeping. It runs after the commit, so a loss here is
 * a diagnostics gap and never a failed create: the session exists and will be
 * provisioned whether or not the timing patch was recorded.
 */
async function mergeTimings(deps: ControlApiDeps, body: CompleteBody): Promise<void> {
  if (!body.timings) return;
  await deps.store.mergeTimings(body.sessionId, body.timings).catch((err: unknown) => {
    log.warn("session_timings_not_recorded", {
      sessionId: body.sessionId,
      error: (err as Error).message,
    });
  });
}

async function settle(
  deps: ControlApiDeps,
  paymentKey: string,
  body: CompleteBody,
  spec: SessionSpec,
  expectedHash: string,
): Promise<Settlement> {
  const now = Date.now();
  let completed: { sessionId: string; created: boolean };
  try {
    completed = await deps.store.completeEntitlement(
      paymentKey,
      body.claimToken,
      paymentRecord(paymentKey, body),
      paidSession(deps, paymentKey, body, spec, now),
    );
  } catch (err) {
    // Only a failure of the transaction lands here. Everything below runs after
    // the commit, and a create that exists must not be released or answered 5xx
    // because a later write failed.
    const settlement = await settlementFailure(deps, paymentKey, body, err);
    if (settlement.kind === "recovered") {
      // This request bound the payment's reservation to a session id that was
      // never written, possibly after the winner bound it to the real one. Point
      // it back: the row is the winner's, and the grace must not expire a live
      // session's capacity.
      await deps.capacity
        .attach(paymentKey, settlement.sessionId, expectedHash, spec)
        .catch(() => undefined);
    }
    return settlement;
  }
  if (completed.created) {
    await mergeTimings(deps, body);
    metrics.counter("sandbox_sessions_created_total", "Entitlements created").inc({
      tier: spec.tier,
    });
    return { kind: "created", sessionId: completed.sessionId };
  }
  // Another worker settled this intent first. Our provisional admission may
  // have bound the payment's capacity hold to a session id that was never
  // durable, so point it back at the winner. Best effort: the winning session
  // already owns the entitlement.
  await deps.capacity
    .attach(paymentKey, completed.sessionId, expectedHash, spec)
    .catch(() => undefined);
  return { kind: "idempotent", sessionId: completed.sessionId };
}

/** Write one settlement outcome as its wire answer. */
async function answerSettlement(
  deps: ControlApiDeps,
  paymentKey: string,
  body: CompleteBody,
  spec: SessionSpec,
  settlement: Settlement,
  res: Response,
): Promise<void> {
  if (
    settlement.kind === "duplicate" ||
    settlement.kind === "already_redeemed" ||
    settlement.kind === "stale_claim"
  ) {
    answerRefusal(settlement, res);
    return;
  }
  await answerSuccess(deps, paymentKey, body, spec, settlement, res);
}

/** The answers that carry a session: a create, a replay, or a recovered claim. */
async function answerSuccess(
  deps: ControlApiDeps,
  paymentKey: string,
  body: CompleteBody,
  spec: SessionSpec,
  settlement: Extract<Settlement, { kind: "created" | "idempotent" | "recovered" }>,
  res: Response,
): Promise<void> {
  if (settlement.kind === "created") {
    log.info("entitlement_created", {
      sessionId: body.sessionId,
      tier: spec.tier,
      durationSeconds: spec.durationSeconds,
      paymentKeyPrefix: paymentKey.slice(0, 12),
    });
    res.status(201).json(await completionResponse(deps.store, body.sessionId, true));
    return;
  }
  if (settlement.kind === "idempotent") {
    log.info("entitlement_idempotent_completion", {
      sessionId: settlement.sessionId,
      paymentKeyPrefix: paymentKey.slice(0, 12),
    });
  }
  // A recovered claim answers like an idempotent one, but there is no
  // completion of ours to log: the winning worker already logged its create.
  res.json(await completionResponse(deps.store, settlement.sessionId, false));
}

/** The refusals that spend no session. */
function answerRefusal(
  settlement: Extract<Settlement, { kind: "duplicate" | "already_redeemed" | "stale_claim" }>,
  res: Response,
): void {
  if (settlement.kind === "duplicate") {
    res.status(409).json({
      error: "duplicate_session",
      sessionId: settlement.sessionId,
      message: "this client key already owns a session; the new payment was recorded for refund",
    });
    return;
  }
  if (settlement.kind === "already_redeemed") {
    res.status(409).json({
      error: "payment_already_redeemed",
      sessionId: settlement.sessionId,
    });
    return;
  }
  res.status(409).json({
    error: "stale_claim",
    message: "this intent is no longer held by this claim",
  });
}

/**
 * The fences before any capacity is spent: the intent exists and is not already
 * settled, the body names the same payment, the presented claim is live, and the
 * spec is one this controller would have priced. A refusal is written here.
 */
async function admitCompletion(
  deps: ControlApiDeps,
  paymentKey: string,
  body: CompleteBody,
  res: Response,
): Promise<BoundSpec | { ok: false }> {
  const intent = await deps.store.getPaymentIntent(paymentKey);
  if (!intent) {
    res.status(409).json({ error: "intent_not_claimed" });
    return { ok: false };
  }
  if (intent.status === "settled") {
    res.json(await completionResponse(deps.store, intent.sessionId, false));
    return { ok: false };
  }
  if (body.payment.paymentKey !== paymentKey) {
    res.status(400).json({ error: "payment_key_mismatch" });
    return { ok: false };
  }
  // Early fence: never spend capacity or validate a spec for an owner whose
  // claim was already reclaimed. The store re-checks inside the settlement
  // transaction with the same predicate, which is what makes this safe.
  if (intent.status !== "claimed" || !isHeldBy(intent.claimToken, body.claimToken)) {
    res.status(409).json({
      error: "stale_claim",
      message: "this intent is not held by the presented claim",
    });
    return { ok: false };
  }
  const bound = bindSpec(body, intent.specHash, deps);
  if (!bound.ok) {
    res.status(bound.status).json(bound.body);
    return { ok: false };
  }
  return bound;
}

async function completeRoute(
  deps: ControlApiDeps,
  req: Request,
  res: Response,
): Promise<void> {
  const paymentKey = String(req.params.paymentKey ?? "");
  const parsed = completeSchema.safeParse(req.body);
  if (!parsed.success) {
    invalidRequest(res, parsed.error.issues);
    return;
  }
  const body = parsed.data;
  const bound = await admitCompletion(deps, paymentKey, body, res);
  if (!bound.ok) return;

  const admission = await deps.capacity.attach(
    paymentKey,
    body.sessionId,
    bound.expectedHash,
    bound.spec,
  );
  if (!admission.admitted) {
    res.status(409).json({
      error: "capacity_unavailable",
      retryable: admission.retryable,
      requested: admission.requested,
    });
    return;
  }

  const settlement = await settle(deps, paymentKey, body, bound.spec, bound.expectedHash);
  await answerSettlement(deps, paymentKey, body, bound.spec, settlement, res);
}

export function mountCompleteRoutes(app: Express, deps: ControlApiDeps): void {
  app.post("/internal/payment-intents/:paymentKey/complete", (req, res) =>
    completeRoute(deps, req, res),
  );
}
