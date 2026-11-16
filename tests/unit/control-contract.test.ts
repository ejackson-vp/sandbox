/**
 * The `/internal/*` contract, held to one definition.
 *
 * The API and the controller are one deployment, but their types were two: the
 * API hand-mirrored the claim, budget, allowlist, switch and capacity answers,
 * and the copies had already drifted. `scope` and `reason` were `string` in the
 * API and closed unions in the controller, so a new refusal compiled on both
 * sides and was counted under `sandbox_rate_limited_total{scope=...}` as a
 * different bucket than it was. This file is what makes that impossible again.
 *
 * Two halves, and neither works alone:
 *
 *  - build time: `sameType` proves that the API's client answers and the
 *    controller's store answers are the *same declarations* as the shared ones.
 *    Re-declaring a copy in either workspace resolves to a different type and
 *    fails `tsc -p tsconfig.tests.json`, which `npm run typecheck` runs. This is
 *    the half that would have caught the original drift.
 *  - run time: the real control API is driven over HTTP and each body is
 *    checked against the shared `const` arrays. A route that emits a member the
 *    union does not have is caught here, whatever the types say.
 *
 * What the runtime half cannot prove is that the controller *cannot* emit an
 * unknown member: the arrays are the same ones the controller's types derive
 * from, so a value outside them would have to be smuggled past a cast. What it
 * does prove is that today's routes send what the API is written against,
 * including the projection that put a `nodeId` on a capacity hold the API had
 * been promised and never received.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMISSION_REJECTION_REASONS,
  ALLOWLIST_REFUSAL_REASONS,
  BUDGET_SCOPES,
  CHALLENGE_BURN_STATUSES,
  type AllowlistDecision,
  type BudgetDecision,
  type CapacityDecision,
  type ChallengeBurnResult,
  type CreateSwitchState,
  type IntentClaimResult,
  type IntentCompletion,
  type IssuedChallengeNonce,
  type SessionSpec,
} from "@x402s/shared/protocol";
import { specHash } from "@x402s/shared/payment";
import { ControllerClient } from "../../api/src/controller-client.js";
import type { AdmissionDecision } from "../../controller/src/capacity/types.js";
import type { CapacityService } from "../../controller/src/capacity/service.js";
import { createControlApi } from "../../controller/src/control-api.js";
import { loadControllerConfig } from "../../controller/src/config.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import type { ControlApiStore } from "../../controller/src/store/ports.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import { freshStore, testDatabaseUrl } from "../helpers/test-store.js";

const ADMIN = "control-contract-token-0123456789";

/* -------------------------------------------------------------------------
 * What "the same type" means here.
 *
 * Mutual assignability in both directions: a widened copy (`scope: string`)
 * fails the first direction, a narrowed one fails the second, and an added
 * optional field fails the second as well. `[A] extends [B]` is deliberate: a
 * bare `A extends B` distributes over a union and would answer a different
 * question.
 * ---------------------------------------------------------------------- */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Compile-time assertion. It is a value so the test can assert on it at run
 * time too, but the assertion itself is the parameter type: only `true` type
 * checks when `A` and `B` are the same declaration.
 */
function sameType<A, B>(identical: Same<A, B>): Same<A, B> {
  return identical;
}

/* -------------------------------------------------------------------------
 * Build time: the API parses the shared declarations.
 * ---------------------------------------------------------------------- */
const CLAIM_IS_SHARED = sameType<Awaited<ReturnType<ControllerClient["claimIntent"]>>, IntentClaimResult>(true);
const COMPLETION_IS_SHARED = sameType<Awaited<ReturnType<ControllerClient["completeIntent"]>>, IntentCompletion>(true);
const NONCE_IS_SHARED = sameType<Awaited<ReturnType<ControllerClient["issueChallengeNonce"]>>, IssuedChallengeNonce>(true);
const BURN_IS_SHARED = sameType<Awaited<ReturnType<ControllerClient["burnChallengeNonce"]>>, ChallengeBurnResult>(true);
const BUDGET_IS_SHARED = sameType<Awaited<ReturnType<ControllerClient["reserveBudget"]>>, BudgetDecision>(true);
const ALLOWLIST_IS_SHARED = sameType<Awaited<ReturnType<ControllerClient["authorizeAllowlistedPayer"]>>, AllowlistDecision>(true);
const SWITCH_IS_SHARED = sameType<Awaited<ReturnType<ControllerClient["readCreateSwitch"]>>, CreateSwitchState>(true);
const PREFLIGHT_IS_SHARED = sameType<Awaited<ReturnType<ControllerClient["preflightCapacity"]>>, CapacityDecision>(true);
const HOLD_IS_SHARED = sameType<Awaited<ReturnType<ControllerClient["holdCapacity"]>>, CapacityDecision>(true);

/* -------------------------------------------------------------------------
 * Build time: the controller produces them.
 *
 * These are the store methods each route serialises, so the body cannot gain a
 * field or widen a union here without the shared declaration moving too.
 *
 * The capacity routes are the exception and it is deliberate: the internal
 * admission decision carries the placement plan and the reservation row, which
 * the API must not act on, so `toCapacityDecision` is the one place the two are
 * related. That the projection accepts both internal decisions is enforced by
 * `capacity/routes.ts` compiling, not by a type-level assertion that could only
 * restate its signature. What is asserted here is the part that can drift: the
 * refusal branch needs no conversion at all, and the admitted branch is checked
 * against the wire body below.
 * ---------------------------------------------------------------------- */
const CLAIM_PRODUCED_AS_SHARED = sameType<Awaited<ReturnType<ControlApiStore["claimPaymentIntent"]>>, IntentClaimResult>(true);
const NONCE_PRODUCED_AS_SHARED = sameType<Awaited<ReturnType<ControlApiStore["issueChallengeNonce"]>>, IssuedChallengeNonce>(true);
const BURN_PRODUCED_AS_SHARED = sameType<Awaited<ReturnType<ControlApiStore["burnChallengeNonce"]>>, ChallengeBurnResult>(true);
const BUDGET_PRODUCED_AS_SHARED = sameType<Awaited<ReturnType<ControlApiStore["reserveBudgets"]>>, BudgetDecision>(true);
const ALLOWLIST_PRODUCED_AS_SHARED = sameType<Awaited<ReturnType<ControlApiStore["authorizeAllowlistedPayer"]>>, AllowlistDecision>(true);
const SWITCH_PRODUCED_AS_SHARED = sameType<Awaited<ReturnType<ControlApiStore["readCreateSwitch"]>>, CreateSwitchState>(true);
const CAPACITY_REFUSAL_IS_WIRE = sameType<
  Extract<AdmissionDecision, { admitted: false }>,
  Extract<CapacityDecision, { admitted: false }>
>(true);

/* -------------------------------------------------------------------------
 * Run time: the real routes, and the bodies they send.
 * ---------------------------------------------------------------------- */

const NODE = "node-contract";
const REQUESTED = { cpuMillicores: 500, memoryBytes: 536_870_912, storageBytes: 268_435_456 };
const ZERO_REMAINING = { cpuMillicores: 0, memoryBytes: 0, storageBytes: 0 };

const SPEC: SessionSpec = {
  tier: "short",
  runtime: "base",
  durationSeconds: 60,
  limits: {
    cpuMillis: 500,
    memoryMiB: 512,
    diskMiB: 256,
    maxOutputBytes: 262_144,
    maxFileBytes: 8 * 1024 * 1024,
    maxCommandSeconds: 60,
    maxProcesses: 64,
  },
};

const PAYER_A = "0x00000000000000000000000000000000000000aa";
const PAYER_B = "0x00000000000000000000000000000000000000bb";
const PAYER_C = "0x00000000000000000000000000000000000000cc";
const ALLOWLISTED = "0x00000000000000000000000000000000000000dd";
const CLAIM_KEY = "a".repeat(64);
const WRONG_HASH = "c".repeat(64);
const HOLD_KEY = "b".repeat(64);

/**
 * Capacity answers with both branches. A hold is a full reservation row, which
 * is the shape the route used to serialise straight through, and a rejection
 * names a real reason from the shared union.
 */
const capacity = {
  preflight: async () => ({
    admitted: true as const,
    nodeId: NODE,
    reservation: { nodeId: NODE, baseline: REQUESTED, peak: REQUESTED, state: "HELD" as const },
    availableAfter: ZERO_REMAINING,
  }),
  hold: async (paymentKey: string) =>
    paymentKey === HOLD_KEY
      ? {
          admitted: true as const,
          reservation: {
            id: "res-contract",
            paymentKey,
            specHash: paymentKey,
            sessionId: null,
            nodeId: NODE,
            state: "HELD" as const,
            podName: null,
            baseline: REQUESTED,
            peak: REQUESTED,
            createdAt: 1,
            updatedAt: 1,
          },
        }
      : {
          admitted: false as const,
          reason: "insufficient_memory" as const,
          retryable: true,
          requested: REQUESTED,
        },
} as unknown as CapacityService;

let store: PostgresStore;
let server: Server;
let base: string;

beforeAll(async () => {
  store = await freshStore({ namespace: "contract" });
  const cfg = loadControllerConfig({
    ADMIN_TOKEN: ADMIN,
    ROLE: "controller",
    KUBERNETES_ENABLED: "false",
    RELAY_ADMIN_TOKEN: "r".repeat(24),
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "p".repeat(24),
    DATABASE_URL: testDatabaseUrl("contract"),
    // Two global creates and one per payer, so one run reaches both buckets: an
    // exhausted payer is `payer_create`, an exhausted cluster is
    // `global_create`, and each is a different metric label.
    GLOBAL_CREATES_PER_WINDOW: "2",
    PAYER_CREATES_PER_WINDOW: "1",
  });
  const app = createControlApi({
    cfg,
    store,
    relay: {} as RelayClient,
    capacity,
  });
  server = http.createServer(app);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  base = `http://127.0.0.1:${port}`;

  await store.upsertAllowlist(
    { address: ALLOWLISTED, label: "contract", maxTier: "short", maxConcurrent: 1 },
    Date.now(),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Answer {
  status: number;
  body: Record<string, unknown> | undefined;
}

async function call(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Answer> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", "x-internal-token": ADMIN },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.status, body: body as Record<string, unknown> | undefined };
}

/** One of `allowed`, or a failure that names the value and the set it escaped. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  expect(typeof value, what).toBe("string");
  expect(allowed, `${what}: ${String(value)}`).toContain(value);
  return value as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The resource vector every capacity answer carries, in one place. */
function expectResourceVector(value: unknown, what: string): void {
  expect(isObject(value), what).toBe(true);
  const vector = value as Record<string, unknown>;
  for (const key of ["cpuMillicores", "memoryBytes", "storageBytes"]) {
    expect(typeof vector[key], `${what}.${key}`).toBe("number");
  }
  expect(Object.keys(vector).sort(), `${what} keys`).toEqual([
    "cpuMillicores",
    "memoryBytes",
    "storageBytes",
  ]);
}

describe("the /internal contract", () => {
  it("proves the API's client answers with the shared declarations", () => {
    // These are constants: the assertion is the type argument, and `tsc` is the
    // gate. At run time they only say the values are `true`.
    expect([
      CLAIM_IS_SHARED,
      COMPLETION_IS_SHARED,
      NONCE_IS_SHARED,
      BURN_IS_SHARED,
      BUDGET_IS_SHARED,
      ALLOWLIST_IS_SHARED,
      SWITCH_IS_SHARED,
      PREFLIGHT_IS_SHARED,
      HOLD_IS_SHARED,
    ]).toEqual(Array(9).fill(true));
  });

  it("proves the controller's store answers with the shared declarations", () => {
    expect([
      CLAIM_PRODUCED_AS_SHARED,
      NONCE_PRODUCED_AS_SHARED,
      BURN_PRODUCED_AS_SHARED,
      BUDGET_PRODUCED_AS_SHARED,
      ALLOWLIST_PRODUCED_AS_SHARED,
      SWITCH_PRODUCED_AS_SHARED,
      CAPACITY_REFUSAL_IS_WIRE,
    ]).toEqual(Array(7).fill(true));
  });

  it("keeps each closed union unique, so no label value is counted twice", () => {
    for (const [name, values] of Object.entries({
      BUDGET_SCOPES,
      ALLOWLIST_REFUSAL_REASONS,
      ADMISSION_REJECTION_REASONS,
      CHALLENGE_BURN_STATUSES,
    })) {
      expect(values.length, name).toBeGreaterThan(0);
      expect(new Set(values).size, name).toBe(values.length);
    }
  });

  it("answers the claim in one of its five documented branches", async () => {
    const claimed = await call("/internal/payment-intents/claim", {
      body: { paymentKey: CLAIM_KEY, specHash: specHash(SPEC) },
    });
    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({ status: "claimed", recovered: false });
    expect(typeof claimed.body?.token).toBe("string");
    expect(typeof claimed.body?.expiresAt).toBe("number");

    const inProgress = await call("/internal/payment-intents/claim", {
      body: { paymentKey: CLAIM_KEY, specHash: specHash(SPEC) },
    });
    expect(inProgress.status).toBe(409);
    // `in_progress` is one body of the shared union, not an error envelope.
    expect(inProgress.body).toEqual({ status: "in_progress" });
  });

  it("answers a spec mismatch as a decided body", async () => {
    const mismatchKey = "d".repeat(64);
    await call("/internal/payment-intents/claim", {
      body: { paymentKey: mismatchKey, specHash: specHash(SPEC) },
    });
    const mismatch = await call("/internal/payment-intents/claim", {
      body: { paymentKey: mismatchKey, specHash: WRONG_HASH },
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body).toMatchObject({ status: "mismatch" });
  });

  it("answers a budget refusal with a scope from the closed union, in both buckets", async () => {
    const reserve = (payer: string) =>
      call("/internal/budgets/reserve", { body: { payer, amount: "1" } });

    const first = await reserve(PAYER_A);
    expect(first.status).toBe(200);
    expect(first.body?.ok).toBe(true);
    expect(typeof first.body?.windowResetsAt).toBe("number");
    expect(isObject(first.body?.remaining)).toBe(true);

    // One per payer, so the same payer's second reserve is a payer refusal.
    const payerRefused = await reserve(PAYER_A);
    expect(payerRefused.body?.ok).toBe(false);
    expect(oneOf(payerRefused.body?.scope, BUDGET_SCOPES, "payer scope")).toBe("payer_create");
    expect(typeof payerRefused.body?.retryAfterSeconds).toBe("number");

    // Two globals, so filling them takes one more admitted payer and a refusal
    // for the next one.
    expect((await reserve(PAYER_B)).body?.ok).toBe(true);
    const globalRefused = await reserve(PAYER_C);
    expect(oneOf(globalRefused.body?.scope, BUDGET_SCOPES, "global scope")).toBe(
      "global_create",
    );
  });

  it("answers the allowlist with a refusal reason from the closed union", async () => {
    const refusedCaller = await call("/internal/payer-allowlist/authorize", {
      body: { address: PAYER_C, tier: "short" },
    });
    expect(refusedCaller.body).toMatchObject({ allowed: false });
    oneOf(refusedCaller.body?.reason, ALLOWLIST_REFUSAL_REASONS, "allowlist reason");

    // On the list, but above its ceiling: a different member of the same union.
    const overTier = await call("/internal/payer-allowlist/authorize", {
      body: { address: ALLOWLISTED, tier: "standard" },
    });
    expect(oneOf(overTier.body?.reason, ALLOWLIST_REFUSAL_REASONS, "tier reason")).toBe(
      "tier_not_allowed",
    );

    const granted = await call("/internal/payer-allowlist/authorize", {
      body: { address: ALLOWLISTED, tier: "short" },
    });
    expect(granted.body).toEqual({
      allowed: true,
      label: "contract",
      maxTier: "short",
      maxConcurrent: 1,
    });
  });

  it("answers the create switch with the effective state", async () => {
    const read = await call("/internal/create-switch", { method: "GET" });
    expect(read.status).toBe(200);
    const state = read.body?.switch as Record<string, unknown> | undefined;
    expect(isObject(state)).toBe(true);
    expect(Object.keys(state ?? {}).sort()).toEqual([
      "actor",
      "changedAt",
      "enabled",
      "expired",
      "expiresAt",
      "reason",
    ]);
    expect(typeof state?.enabled).toBe("boolean");
    expect(typeof state?.expired).toBe("boolean");
  });

  it("answers a challenge issue and burn with members of the shared unions", async () => {
    const issued = await call("/internal/challenge-nonces", { body: {} });
    expect(issued.status).toBe(201);
    expect(typeof issued.body?.nonce).toBe("string");
    expect(typeof issued.body?.expiresAt).toBe("number");

    const burned = await call(
      `/internal/challenge-nonces/${encodeURIComponent(String(issued.body?.nonce))}/burn`,
      { body: { paymentKey: CLAIM_KEY } },
    );
    expect(oneOf(burned.body?.status, CHALLENGE_BURN_STATUSES, "burn status")).toBe("burned");

    // The same payment again is the recovery path, not an error.
    const replay = await call(
      `/internal/challenge-nonces/${encodeURIComponent(String(issued.body?.nonce))}/burn`,
      { body: { paymentKey: CLAIM_KEY } },
    );
    expect(oneOf(replay.body?.status, CHALLENGE_BURN_STATUSES, "burn status")).toBe("replay");
  });

  it("sends a capacity hold that names the node the API was promised", async () => {
    const held = await call("/internal/capacity/holds", {
      body: { paymentKey: HOLD_KEY, specHash: HOLD_KEY, spec: SPEC },
    });
    expect(held.status).toBe(200);
    expect(held.body).toMatchObject({ admitted: true, nodeId: NODE });
    // The reservation row is the controller's. What crosses the wire is the
    // node identity, so a hold body cannot drift into a second shape.
    expect(held.body?.reservation).toEqual({ nodeId: NODE });
  });

  it("sends a capacity refusal with a reason from the closed union", async () => {
    const refused = await call("/internal/capacity/holds", {
      body: { paymentKey: "e".repeat(64), specHash: "e".repeat(64), spec: SPEC },
    });
    expect(refused.status).toBe(409);
    expect(refused.body?.admitted).toBe(false);
    oneOf(refused.body?.reason, ADMISSION_REJECTION_REASONS, "admission reason");
    expect(typeof refused.body?.retryable).toBe("boolean");
    expectResourceVector(refused.body?.requested, "requested");
  });

  it("sends a preflight with the same shape as a hold", async () => {
    const preflight = await call("/internal/capacity/preflight", { body: { spec: SPEC } });
    expect(preflight.status).toBe(200);
    expect(preflight.body).toMatchObject({ admitted: true, nodeId: NODE });
    expectResourceVector(preflight.body?.availableAfter, "availableAfter");
  });
});
