/**
 * API server configuration with fail-closed validation.
 *
 * There is no path to mainnet: a mainnet network id is rejected at startup even
 * if every other flag is set. Testnet is opt-in and documented.
 */
import {
  MOCK_NETWORK,
  loadPlatformLimits,
  loadTiers,
  type PlatformLimits,
  type TierTable,
} from "@x402s/shared";

export type PaymentMode = "mock" | "testnet";

function bool(v: string | undefined, def = false): boolean {
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function int(v: string | undefined, def: number, min: number, max: number): number {
  const n = v === undefined || v === "" ? def : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`invalid integer config value ${v} (expected ${min}..${max})`);
  }
  return n;
}

const MAINNET_NETWORKS = new Set(["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
const TESTNET_NETWORKS = new Set(["eip155:84532", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"]);

export interface ApiConfig {
  port: number;
  paymentMode: PaymentMode;
  network: string;
  priceUsd: string;
  payTo: string;
  facilitatorUrl: string;
  controllerUrl: string;
  controllerAdminToken: string;
  capabilitySecret: string;
  capabilityTtlSeconds: number;
  maxBodyBytes: number;
  allowInsecureDev: boolean;
  publicBaseUrl: string;
  requestTimeoutMs: number;
  intentStaleMs: number;
  createRateBurst: number;
  createRateRefill: number;
  createIpRateBurst: number;
  createIpRateRefill: number;
  tiers: TierTable;
  platformLimits: PlatformLimits;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const paymentMode = (env.PAYMENT_MODE ?? "mock") as PaymentMode;
  if (paymentMode !== "mock" && paymentMode !== "testnet") {
    throw new Error(`PAYMENT_MODE must be "mock" or "testnet", got ${paymentMode}`);
  }

  const requestedNetwork = env.NETWORK ?? (paymentMode === "mock" ? MOCK_NETWORK : "eip155:84532");
  if (MAINNET_NETWORKS.has(requestedNetwork)) {
    throw new Error(
      "refusing to start: mainnet payments are not enabled in this build (no silent mainnet activation)",
    );
  }
  if (paymentMode === "testnet" && !TESTNET_NETWORKS.has(requestedNetwork)) {
    throw new Error(`testnet payment mode requires a documented testnet network, got ${requestedNetwork}`);
  }
  if (paymentMode === "mock" && requestedNetwork !== MOCK_NETWORK) {
    throw new Error(`mock payment mode requires network ${MOCK_NETWORK}, got ${requestedNetwork}`);
  }

  const allowInsecureDev = bool(env.ALLOW_INSECURE_DEV, paymentMode === "mock");
  if (paymentMode === "mock" && !allowInsecureDev) {
    throw new Error("mock payments require ALLOW_INSECURE_DEV=true (mock payments have no economic security)");
  }

  const facilitatorUrl =
    env.FACILITATOR_URL ??
    (paymentMode === "mock" ? "http://127.0.0.1:3002" : "https://x402.org/facilitator");

  const payTo =
    env.PAY_TO ?? (paymentMode === "mock" ? "0x0000000000000000000000000000000000000402" : "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    throw new Error("PAY_TO must be a 20-byte EVM address");
  }
  if (paymentMode === "testnet" && payTo === "0x0000000000000000000000000000000000000402") {
    throw new Error("PAY_TO must be a real receiving address in testnet mode");
  }

  const controllerAdminToken = env.CONTROLLER_ADMIN_TOKEN ?? env.ADMIN_TOKEN ?? "";
  const capabilitySecret = env.CAPABILITY_SECRET ?? controllerAdminToken;
  if (capabilitySecret.length < 16) {
    throw new Error("CAPABILITY_SECRET (or CONTROLLER_ADMIN_TOKEN) must be at least 16 characters");
  }

  return {
    port: int(env.PORT, 3000, 1, 65535),
    paymentMode,
    network: requestedNetwork,
    // Default price is used only for the pricing endpoint when no tier is given.
    priceUsd: env.PRICE_USD ?? "$0.05",
    payTo,
    facilitatorUrl,
    controllerUrl: env.CONTROLLER_URL ?? "http://127.0.0.1:3001",
    controllerAdminToken,
    capabilitySecret,
    capabilityTtlSeconds: int(env.CAPABILITY_GRACE_SECONDS ?? env.CAPABILITY_TTL_SECONDS, 900, 60, 7200),
    maxBodyBytes: int(env.MAX_BODY_BYTES, 32 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    allowInsecureDev,
    publicBaseUrl: env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT ?? "3000"}`,
    requestTimeoutMs: int(env.REQUEST_TIMEOUT_MS, 180_000, 1000, 600_000),
    intentStaleMs: int(env.PAYMENT_INTENT_STALE_MS, 30_000, 1000, 600_000),
    createRateBurst: int(env.CREATE_RATE_BURST, 30, 1, 100_000),
    createRateRefill: int(env.CREATE_RATE_REFILL, 1, 1, 100_000),
    createIpRateBurst: int(env.CREATE_IP_RATE_BURST, 120, 1, 100_000),
    createIpRateRefill: int(env.CREATE_IP_RATE_REFILL, 10, 1, 100_000),
    tiers: loadTiers(env),
    platformLimits: loadPlatformLimits(env),
  };
}
