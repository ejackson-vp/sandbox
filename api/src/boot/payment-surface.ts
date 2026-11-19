/**
 * The x402 surface: who settles a payment, who verifies it on chain, how a
 * price becomes a payment requirement, and the capability a settled session
 * hands back.
 *
 * This was the first 130 lines of `createApp`, and it is the part with the most
 * startup order in it: the facilitator client must be built before the scheme
 * is registered, the scheme before `initialize()`, and `initialize()` before a
 * request can build a requirement. Keeping it in one module means the order is
 * one function to read.
 */
import { x402ResourceServer } from "@x402/core/server";
import type { Network, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { mintCapability, recoverCapability } from "@x402s/shared/crypto";
import { MOCK_NETWORK, MockExactServerScheme, resolveSessionSpec } from "@x402s/shared/payment";
import type { SessionSpec } from "@x402s/shared/protocol";
import {
  HttpSettlementLookup,
  UnsupportedSettlementLookup,
  backoffMs,
  log,
  type SettlementLookup,
} from "@x402s/shared/runtime";
import type { ApiConfig } from "../config.js";
import { sessionBazaarExtension } from "../payments/bazaar.js";
import { createFacilitatorClient } from "../payments/facilitator-client.js";
import {
  createPaymentRequiredWriter,
  type DiscoveryEcho,
} from "../payments/payment-required.js";
import { buildSettlementVerifier } from "../payments/settlement-confirmation.js";
import type { ApiDeps } from "./deps.js";

export type RequirementFor = (priceUsd: string, spec: SessionSpec) => Promise<PaymentRequirements>;

export interface PaymentSurface {
  settlementLookup: SettlementLookup;
  /** Absent when the deployment has no chain verifier configured. */
  settlementVerifier: ReturnType<typeof buildSettlementVerifier>;
  resourceServer: x402ResourceServer;
  requirementFor: RequirementFor;
  payment402: ReturnType<typeof createPaymentRequiredWriter>;
  /**
   * What a settled payment echoes back to the facilitator, when discovery is
   * on. The Bazaar indexes from the settlement call rather than from the 402,
   * so the resource and the extension have to ride on the payload too.
   */
  discovery?: DiscoveryEcho;
  /** Bound to the payment and the client commitment, not to the key alone. */
  capabilityFor(key: string, commitment: string): string;
  /** A replay hands back the token the client already holds; null means the
   *  signing key that made it was retired too early. */
  recoverCapability(key: string, commitment: string, storedHash: string): string | null;
}

/**
 * The tier the Bazaar example quotes.
 *
 * The example body is what the indexer replays and what a discovering agent
 * copies first, so it is the cheapest session rather than the most useful one:
 * the first call a stranger makes should be the smallest amount of money they
 * can lose on a service they have not tried.
 */
const BAZAAR_EXAMPLE_TIER = "short";

/** The resource as an agent reads it in a catalogue. Under the Bazaar's 500 chars. */
const RESOURCE_DESCRIPTION =
  "One disposable Linux machine, paid per session in USDC on Base, with no account. " +
  "A session runs shell commands and files under /workspace for a fixed lease, then the " +
  "machine and its workspace are destroyed; there is no suspend and no resume. " +
  "Suitable for a short untrusted job, a test run or a build step that must not outlive it.";

/**
 * Discovery metadata, or nothing.
 *
 * A deployment that switches discovery off gets the plain 402 it always had:
 * the payment path does not depend on being listed anywhere.
 */
function bazaarExtensions(config: ApiConfig): Record<string, unknown> | undefined {
  if (!config.bazaarDiscoveryEnabled) return undefined;
  const resolution = resolveSessionSpec(
    {
      tier: BAZAAR_EXAMPLE_TIER,
      clientPublicKey: "A".repeat(44),
      clientNonce: "B".repeat(44),
    },
    config.tiers,
    config.platformLimits,
  );
  if (!resolution.ok) {
    throw new Error(
      `bazaar example tier ${BAZAAR_EXAMPLE_TIER} does not resolve: ${resolution.code} ${resolution.message}`,
    );
  }
  return sessionBazaarExtension({
    tiers: config.tiers,
    exampleTier: BAZAAR_EXAMPLE_TIER,
    runtime: resolution.spec.runtime,
    limits: resolution.spec.limits,
  });
}

/** Build the facilitator, settle and verify half of the app. */
export async function createPaymentSurface(deps: ApiDeps): Promise<PaymentSurface> {
  const { config, controller } = deps;
  const resourceServer = await createResourceServer(deps);
  const resourceInfo = {
    url: `${config.publicBaseUrl}/v1/sessions`,
    description: RESOURCE_DESCRIPTION,
    mimeType: "application/json",
    serviceName: "x402 sandbox sessions",
    tags: ["sandbox", "linux", "code-execution", "microvm", "disposable"],
    ...(config.bazaarIconUrl ? { iconUrl: config.bazaarIconUrl } : {}),
  };
  const extensions = bazaarExtensions(config);
  return {
    settlementLookup: resolveSettlementLookup(deps),
    settlementVerifier: deps.settlementVerifier ?? buildSettlementVerifier(config),
    resourceServer,
    requirementFor: createRequirementBuilder(config, resourceServer),
    payment402: createPaymentRequiredWriter({ controller, resourceServer, resourceInfo, extensions }),
    ...(extensions ? { discovery: { resource: resourceInfo, extensions } } : {}),
    capabilityFor: (key, commitment) => mintCapability(config.capabilityKeys.signing, key, commitment),
    recoverCapability: (key, commitment, storedHash) =>
      recoverCapability(config.capabilityKeys, key, commitment, storedHash),
  };
}

function resolveSettlementLookup(deps: ApiDeps): SettlementLookup {
  if (deps.settlementLookup) return deps.settlementLookup;
  // F-10: a chain read is authoritative and needs no facilitator answer, so it
  // replaces the unsupported lookup for EVM networks.
  return deps.config.paymentMode === "mock"
    ? new HttpSettlementLookup(deps.config.facilitatorUrl)
    : new UnsupportedSettlementLookup();
}

async function createResourceServer(deps: ApiDeps): Promise<x402ResourceServer> {
  const { config } = deps;
  // The deployment's own port: bounded timeouts, retries only on the reads, and
  // CDP bearer auth when a key pair is configured.
  const resourceServer = deps.resourceServer ?? new x402ResourceServer(createFacilitatorClient(config));
  if (!deps.resourceServer) {
    if (config.paymentMode === "mock") {
      resourceServer.register(MOCK_NETWORK, new MockExactServerScheme());
    } else {
      // Testnet and mainnet register the same scheme against the configured
      // network, so enabling mainnet is a configuration change, not a code
      // change: Base Sepolia today, Base mainnet when PAYMENT_MODE=mainnet.
      resourceServer.register(config.network as Network, new ExactEvmScheme());
    }
  }
  await retry(
    () => resourceServer.initialize(),
    Number(process.env.FACILITATOR_INIT_TIMEOUT_MS ?? 60_000),
    "facilitator initialization",
  );
  return resourceServer;
}

/**
 * Payment requirements are built per price, because tiers have different
 * prices, and cached by the spec they were built for.
 */
function createRequirementBuilder(
  config: ApiConfig,
  resourceServer: x402ResourceServer,
): RequirementFor {
  const requirementCache = new Map<string, PaymentRequirements>();
  return async (priceUsd, spec) => {
    const key = `${priceUsd}|${spec.tier}|${spec.durationSeconds}`;
    const cached = requirementCache.get(key);
    if (cached) return cached;
    const built = await resourceServer.buildPaymentRequirements({
      scheme: "exact",
      network: config.network as Network,
      payTo: config.payTo,
      price: priceUsd,
      maxTimeoutSeconds: 300,
      extra: { tier: spec.tier, durationSeconds: spec.durationSeconds },
    });
    const requirement = built[0];
    if (!requirement) throw new Error("failed to build payment requirements");
    requirementCache.set(key, requirement);
    return requirement;
  };
}

/**
 * Wait for a dependency to answer, on a sampled exponential delay.
 *
 * Every API replica starts at once after a rollout and calls the same
 * facilitator. An unjittered 250/500/1000/2000/5000 ladder puts the whole fleet
 * on one schedule against a dependency that is still coming up, so the delay is
 * sampled from `[0, min(5000, 250 * 2 ** n)]` and clamped to what is left of the
 * budget.
 */
async function retry<T>(fn: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      log.warn("dependency_not_ready", { dependency: label, error: (err as Error).message });
      const remaining = deadline - Date.now();
      const delay = backoffMs({ baseDelayMs: 250, maxDelayMs: 5_000 }, attempt);
      await new Promise((r) => setTimeout(r, Math.min(delay, Math.max(0, remaining))));
    }
  }
  throw new Error(`${label} did not become available: ${(lastErr as Error)?.message ?? "timeout"}`);
}
