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
  envBool as bool,
  envInt as int,
} from "@x402s/shared";

export type PaymentMode = "mock" | "testnet";

const MAINNET_NETWORKS = new Set(["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
const TESTNET_NETWORKS = new Set(["eip155:84532", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"]);

export interface ApiConfig {
  port: number;
  paymentMode: PaymentMode;
  network: string;
  payTo: string;
  facilitatorUrl: string;
  controllerUrl: string;
  /** Client certificate for the controller's mTLS listener, when enabled. */
  controllerTls?: { certFile: string; keyFile: string; caFile: string };
  controllerAdminToken: string;
  capabilitySecret: string;
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

  const port = int(env.PORT, 3000, 1, 65535);

  // Absolute http(s) URL, no trailing slash: the 402 challenge appends
  // `/v1/sessions` to it, and a stray slash produces a URL with a double slash.
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

  const controllerUrl = env.CONTROLLER_URL ?? "http://127.0.0.1:3001";
  const tlsCertFile = env.CONTROLLER_TLS_CERT_FILE;
  const tlsKeyFile = env.CONTROLLER_TLS_KEY_FILE;
  const tlsCaFile = env.CONTROLLER_TLS_CA_FILE;
  const tlsSet = [tlsCertFile, tlsKeyFile, tlsCaFile].filter(Boolean).length;
  if (tlsSet !== 0 && tlsSet !== 3) {
    throw new Error(
      "CONTROLLER_TLS_CERT_FILE, CONTROLLER_TLS_KEY_FILE and CONTROLLER_TLS_CA_FILE must be set together",
    );
  }
  if (tlsSet === 3 && !controllerUrl.startsWith("https://")) {
    throw new Error("CONTROLLER_TLS_* requires an https CONTROLLER_URL");
  }
  const controllerTls =
    tlsSet === 3
      ? { certFile: tlsCertFile!, keyFile: tlsKeyFile!, caFile: tlsCaFile! }
      : undefined;

  return {
    port,
    paymentMode,
    network: requestedNetwork,
    payTo,
    facilitatorUrl,
    controllerUrl,
    ...(controllerTls ? { controllerTls } : {}),
    controllerAdminToken,
    capabilitySecret,
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
