/**
 * API server configuration with fail-closed validation.
 *
 * There is no path to mainnet: a mainnet network id is rejected at startup even
 * if every other flag is set. Testnet is opt-in and documented.
 */
import { envBool as bool, envInt as int, envTlsFiles } from "@x402s/shared/env";
import {
  CAPABILITY_KEY_ID_PATTERN,
  capabilityKeyRing,
  type CapabilityKeyRing,
} from "@x402s/shared/crypto";
import {
  MOCK_NETWORK,
  loadPlatformLimits,
  loadTiers,
  type PlatformLimits,
  type TierTable,
} from "@x402s/shared/payment";
import { DEFAULT_METRICS_PORT } from "@x402s/shared/runtime";
import { usdcAddressFor } from "./payments/settlement-verifier.js";

type PaymentMode = "mock" | "testnet";

const MAINNET_NETWORKS = new Set(["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
const TESTNET_NETWORKS = new Set(["eip155:84532", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"]);

export interface ApiConfig {
  port: number;
  /** Private scrape listener. 0 disables it (tests / non-Kubernetes runs). */
  metricsPort: number;
  metricsHost: string;
  paymentMode: PaymentMode;
  network: string;
  payTo: string;
  facilitatorUrl: string;
  /**
   * JSON-RPC endpoint used to read EIP-3009 authorization state on chain.
   * Unset on the mock path and on a testnet deployment without an RPC. Mainnet
   * refuses to start without it.
   */
  paymentRpcUrl?: string;
  /** USDC contract that holds the authorizations. Defaults per network. */
  paymentUsdcAddress?: `0x${string}`;
  controllerUrl: string;
  /** Client certificate for the controller's mTLS listener, when enabled. */
  controllerTls?: { certFile: string; keyFile: string; caFile: string };
  controllerAdminToken: string;
  capabilitySecret: string;
  /**
   * Signing key plus any key still inside the rotation overlap window. The
   * secret itself never leaves this object: handlers use the ring helpers.
   */
  capabilityKeys: CapabilityKeyRing;
  capabilityTtlSeconds: number;
  maxBodyBytes: number;
  publicBaseUrl: string;
  /** Time allowed to receive request headers. Receipt only; not handler time. */
  httpHeadersTimeoutMs: number;
  /** Time allowed to receive a complete request (headers + body). */
  httpRequestTimeoutMs: number;
  /**
   * Trusted proxy hops for `req.ip`. 0 disables it (direct clients only). Set to
   * 1 only when the API is reachable exclusively through one reverse proxy.
   */
  trustProxyHops: number;
  intentStaleMs: number;
  createRateBurst: number;
  createRateRefill: number;
  createIpRateBurst: number;
  createIpRateRefill: number;
  readRateBurst: number;
  readRateRefill: number;
  tiers: TierTable;
  platformLimits: PlatformLimits;
}

function parsePayment(env: NodeJS.ProcessEnv): Pick<ApiConfig, "paymentMode" | "network" | "payTo" | "facilitatorUrl"> {
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
  return { paymentMode, network: requestedNetwork, payTo, facilitatorUrl };
}

/**
 * The on-chain settlement verifier (F-10). It is opt-in for the mock and
 * testnet paths: no `PAYMENT_RPC_URL` means the facilitator lookup is still the
 * only recovery mechanism, which is what those deployments had before.
 *
 * The USDC address defaults per network so a deployment cannot accidentally
 * read a different token's state, and an override is validated as a 20-byte
 * address rather than trusted.
 */
function parseChainVerification(
  env: NodeJS.ProcessEnv,
  paymentMode: PaymentMode,
  network: string,
): Pick<ApiConfig, "paymentRpcUrl" | "paymentUsdcAddress"> {
  // The mock scheme has no chain, so a mock deployment ignores the setting
  // rather than refusing to start because a dev box has one exported.
  if (paymentMode === "mock") return {};
  const rpcUrl = (env.PAYMENT_RPC_URL ?? "").trim();
  if (rpcUrl.length === 0) {
    return {};
  }
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new Error("PAYMENT_RPC_URL must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("PAYMENT_RPC_URL must be an absolute http(s) URL");
  }
  const override = (env.PAYMENT_USDC_ADDRESS ?? "").trim();
  if (override.length > 0 && !/^0x[0-9a-fA-F]{40}$/.test(override)) {
    throw new Error("PAYMENT_USDC_ADDRESS must be a 20-byte EVM address");
  }
  const usdcAddress = (override || usdcAddressFor(network)) as `0x${string}` | undefined;
  if (!usdcAddress) {
    throw new Error(
      `PAYMENT_RPC_URL requires a known USDC address for ${network}; set PAYMENT_USDC_ADDRESS`,
    );
  }
  return { paymentRpcUrl: rpcUrl, paymentUsdcAddress: usdcAddress };
}

function parseCredentials(
  env: NodeJS.ProcessEnv,
): Pick<ApiConfig, "controllerAdminToken" | "capabilitySecret" | "capabilityKeys"> {
  const controllerAdminToken = env.CONTROLLER_ADMIN_TOKEN ?? env.ADMIN_TOKEN ?? "";
  if (controllerAdminToken.length < 16) {
    throw new Error("CONTROLLER_ADMIN_TOKEN (or ADMIN_TOKEN) must be at least 16 characters");
  }

  // Key separation is not optional: the capability secret derives session
  // capabilities, the admin token authenticates to the controller. Sharing one
  // key would make a leaked capability key valid against the controller, and
  // rotating either would silently invalidate the other.
  const capabilitySecret = env.CAPABILITY_SECRET ?? "";
  if (capabilitySecret.length < 16) {
    throw new Error("CAPABILITY_SECRET is required and must be at least 16 characters");
  }
  if (capabilitySecret === controllerAdminToken) {
    throw new Error("CAPABILITY_SECRET must differ from CONTROLLER_ADMIN_TOKEN");
  }

  // Rotation without draining: the previous key verifies existing capabilities
  // while the current key signs new ones. It is opt-in, so a single-key
  // deployment needs no new configuration and keeps minting the same tokens.
  const keyId = env.CAPABILITY_KEY_ID ?? "k1";
  if (!CAPABILITY_KEY_ID_PATTERN.test(keyId)) {
    throw new Error("CAPABILITY_KEY_ID must be 1-16 characters of [A-Za-z0-9_-]");
  }
  const previousSecret = env.CAPABILITY_SECRET_PREVIOUS ?? "";
  const previousKeyId = env.CAPABILITY_PREVIOUS_KEY_ID ?? "";
  if (previousSecret.length > 0 && previousSecret.length < 16) {
    throw new Error("CAPABILITY_SECRET_PREVIOUS must be at least 16 characters when set");
  }
  if (previousSecret === capabilitySecret) {
    throw new Error("CAPABILITY_SECRET_PREVIOUS must differ from CAPABILITY_SECRET");
  }
  if (previousSecret.length > 0 && !CAPABILITY_KEY_ID_PATTERN.test(previousKeyId)) {
    throw new Error("CAPABILITY_PREVIOUS_KEY_ID is required with CAPABILITY_SECRET_PREVIOUS and must be 1-16 characters of [A-Za-z0-9_-]");
  }
  if (previousKeyId.length > 0 && previousKeyId === keyId) {
    throw new Error("CAPABILITY_PREVIOUS_KEY_ID must differ from CAPABILITY_KEY_ID");
  }
  if (previousSecret.length > 0 && previousSecret === controllerAdminToken) {
    throw new Error("CAPABILITY_SECRET_PREVIOUS must differ from CONTROLLER_ADMIN_TOKEN");
  }

  const capabilityKeys = capabilityKeyRing({
    keyId,
    secret: capabilitySecret,
    ...(previousSecret.length > 0 ? { previous: { keyId: previousKeyId, secret: previousSecret } } : {}),
  });
  return { controllerAdminToken, capabilitySecret, capabilityKeys };
}

function parsePublicBaseUrl(env: NodeJS.ProcessEnv, port: number): string {
  const rawPublicBaseUrl = env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
  let publicBaseUrl: string;
  try {
    const parsed = new URL(rawPublicBaseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported scheme");
    }
    publicBaseUrl = rawPublicBaseUrl.replace(/\/+$/, "");
  } catch {
    throw new Error(`PUBLIC_BASE_URL must be an absolute http(s) URL, got ${rawPublicBaseUrl}`);
  }
  return publicBaseUrl;
}

function parseControllerTls(env: NodeJS.ProcessEnv, controllerUrl: string): ApiConfig["controllerTls"] {
  const controllerTls = envTlsFiles(env, "CONTROLLER_TLS");
  if (controllerTls && !controllerUrl.startsWith("https://")) {
    throw new Error("CONTROLLER_TLS_* requires an https CONTROLLER_URL");
  }
  return controllerTls;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const payment = parsePayment(env);

  const chainVerification = parseChainVerification(env, payment.paymentMode, payment.network);

  const credentials = parseCredentials(env);

  const port = int(env.PORT, 3000, 1, 65535);

  // Absolute http(s) URL, no trailing slash: the 402 challenge appends
  // `/v1/sessions` to it, and a stray slash produces a URL with a double slash.
  const publicBaseUrl = parsePublicBaseUrl(env, port);

  const controllerUrl = env.CONTROLLER_URL ?? "http://127.0.0.1:3001";
  const controllerTls = parseControllerTls(env, controllerUrl);

  return {
    port,
    // Dedicated scrape listener, never the public ingress port.
    metricsPort: int(env.METRICS_PORT, DEFAULT_METRICS_PORT, 0, 65535),
    metricsHost: env.METRICS_HOST ?? "0.0.0.0",
    ...payment,
    ...chainVerification,
    ...credentials,
    controllerUrl,
    ...(controllerTls ? { controllerTls } : {}),
    capabilityTtlSeconds: int(env.CAPABILITY_GRACE_SECONDS, 900, 60, 7200),
    maxBodyBytes: int(env.MAX_BODY_BYTES, 32 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    publicBaseUrl,
    // Receipt timeouts. They bound slow-header and slow-body clients without
    // limiting handler time, so a long-poll exec is unaffected.
    httpHeadersTimeoutMs: int(env.HTTP_HEADERS_TIMEOUT_MS, 15_000, 1_000, 120_000),
    httpRequestTimeoutMs: int(env.HTTP_REQUEST_TIMEOUT_MS, 60_000, 5_000, 600_000),
    trustProxyHops: int(env.TRUST_PROXY_HOPS, 0, 0, 8),
    intentStaleMs: int(env.PAYMENT_INTENT_STALE_MS, 30_000, 1000, 600_000),
    createRateBurst: int(env.CREATE_RATE_BURST, 30, 1, 100_000),
    createRateRefill: int(env.CREATE_RATE_REFILL, 1, 1, 100_000),
    createIpRateBurst: int(env.CREATE_IP_RATE_BURST, 120, 1, 100_000),
    createIpRateRefill: int(env.CREATE_IP_RATE_REFILL, 10, 1, 100_000),
    readRateBurst: int(env.READ_RATE_BURST, 2_400, 1, 100_000),
    readRateRefill: int(env.READ_RATE_REFILL, 200, 1, 100_000),
    tiers: loadTiers(env),
    platformLimits: loadPlatformLimits(env),
  };
}
