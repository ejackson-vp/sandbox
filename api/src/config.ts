/**
 * API server configuration with fail-closed validation.
 *
 * Three payment modes, in increasing order of consequence:
 *
 *  - `mock` is the local default. It needs `ALLOW_INSECURE_DEV=true` because
 *    the mock facilitator has no economic security, and it ignores chain
 *    settings entirely.
 *  - `testnet` settles a documented testnet network (Base Sepolia by default).
 *  - `mainnet` moves real money and has no default at all: it must be requested
 *    explicitly, `NETWORK` must be in `SETTLEABLE_MAINNET_NETWORKS`, `PAY_TO` must
 *    be a real address, `FACILITATOR_URL` must be set, and an on-chain verifier
 *    (`PAYMENT_RPC_URL`) must be configured. Every check fails closed, so no
 *    single flag can silently turn on real payments.
 */
import { envAllowInsecureDev, envBool as bool, envInt as int, envTlsFiles } from "@x402s/shared/env";
import {
  CAPABILITY_KEY_ID_PATTERN,
  capabilityKeyRing,
  type CapabilityKeyRing,
} from "@x402s/shared/crypto";
import {
  MAINNET_NETWORKS,
  MOCK_NETWORK,
  SETTLEABLE_MAINNET_NETWORKS,
  TESTNET_NETWORK,
  TESTNET_NETWORKS,
  loadPlatformLimits,
  loadTiers,
  type PlatformLimits,
  type TierTable,
} from "@x402s/shared/payment";
import type { PaymentMode } from "@x402s/shared/protocol";
import { DEFAULT_METRICS_PORT } from "@x402s/shared/runtime";
import { parseChainReadSettings } from "@x402s/shared/settlement";

/**
 * The network sets live in `@x402s/shared/payment`, because the controller
 * validates the same NETWORK value and the two processes must agree.
 */
const MOCK_PAY_TO = "0x0000000000000000000000000000000000000402";

export interface ApiConfig {
  port: number;
  /** Private scrape listener. 0 disables it (tests / non-Kubernetes runs). */
  metricsPort: number;
  metricsHost: string;
  paymentMode: PaymentMode;
  network: string;
  payTo: string;
  facilitatorUrl: string;
  /** Per-attempt budget for a facilitator HTTP call. */
  facilitatorTimeoutMs: number;
  /** CDP API key id. Set with the secret, or not at all. */
  facilitatorApiKeyId?: string;
  /**
   * CDP API key secret. Never logged, never put in an error message, and only
   * accepted over an https FACILITATOR_URL.
   */
  facilitatorApiKeySecret?: string;
  /**
   * JSON-RPC endpoint used to read EIP-3009 authorization state on chain.
   * Unset on the mock path and on a testnet deployment without an RPC. Mainnet
   * refuses to start without it.
   */
  paymentRpcUrl?: string;
  /** USDC contract that holds the authorizations. Defaults per network. */
  paymentUsdcAddress?: `0x${string}`;
  /**
   * How far behind head the on-chain settlement check scans for the
   * `AuthorizationUsed` log. Base is 2 s per block, so the 90 000-block default
   * is 50 hours: long enough for the API to settle, stay down, and recover the
   * payment after a restart. The scan runs newest-first and stops at the first
   * chunk that knows the nonce, so a normal payment costs one `eth_getLogs`.
   */
  paymentSettlementLookbackBlocks: number;
  /**
   * Blocks per `eth_getLogs` call. 10 000 matches the per-request range cap most
   * Base providers apply, so the default window is nine calls at worst, one in
   * practice. Lower it for a stricter provider; raise it to make a larger
   * window fit under `MAX_SETTLEMENT_SCAN_QUERIES`.
   */
  paymentSettlementScanChunkBlocks: number;
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
  /**
   * Whether the 402 advertises CDP Bazaar discovery metadata. On by default:
   * the block is inert unless a facilitator indexes it, and a resource that
   * never lists is one no agent can find.
   */
  bazaarDiscoveryEnabled: boolean;
  /** Absolute URL of the icon a catalogue shows for this resource. */
  bazaarIconUrl?: string;
  /** Time allowed to receive request headers. Receipt only; not handler time. */
  httpHeadersTimeoutMs: number;
  /** Time allowed to receive a complete request (headers + body). */
  httpRequestTimeoutMs: number;
  /**
   * Trusted proxy hops for `req.ip`. 0 disables it (direct clients only). Set to
   * 1 only when the API is reachable exclusively through one reverse proxy.
   */
  trustProxyHops: number;
  /**
   * In-flight requests one client (`req.ip`) may hold at once. 0 disables the
   * per-client check. Tailnet-only, the cap was unnecessary; on a public
   * listener one client can otherwise own every slot the process has.
   */
  maxConnectionsPerClient: number;
  /**
   * In-flight requests the process accepts at once, across all clients. A
   * per-client cap alone still lets many clients fill the process, the same
   * reason the egress proxy has a global connection budget.
   */
  maxConnectionsGlobal: number;
  intentStaleMs: number;
  createRateBurst: number;
  createRateRefill: number;
  createIpRateBurst: number;
  createIpRateRefill: number;
  readRateBurst: number;
  readRateRefill: number;
  /**
   * Whether a proven allowlisted address may be granted a free session
   * (ADR 0013). Off by default: this is a trust-boundary feature, so it is
   * turned on deliberately rather than shipping enabled.
   */
  payerAllowlistEnabled: boolean;
  tiers: TierTable;
  platformLimits: PlatformLimits;
}

/**
 * Payment mode, network, recipient and facilitator.
 *
 * Mainnet is opt-in in the strictest sense: the mode must be named, the network
 * must be supplied (there is no mainnet default), and the assertions below must
 * all hold. Nothing here defaults towards moving real money.
 */
function parsePayment(
  env: NodeJS.ProcessEnv,
): Pick<ApiConfig, "paymentMode" | "network" | "payTo" | "facilitatorUrl"> {
  const paymentMode = (env.PAYMENT_MODE ?? "mock") as PaymentMode;
  if (paymentMode !== "mock" && paymentMode !== "testnet" && paymentMode !== "mainnet") {
    throw new Error(`PAYMENT_MODE must be "mock", "testnet" or "mainnet", got ${paymentMode}`);
  }

  if (paymentMode === "mainnet" && !env.NETWORK) {
    throw new Error(
      "PAYMENT_MODE=mainnet requires NETWORK to be set explicitly (there is no mainnet default)",
    );
  }
  const requestedNetwork =
    env.NETWORK ?? (paymentMode === "mock" ? MOCK_NETWORK : TESTNET_NETWORK);

  if (paymentMode !== "mainnet" && MAINNET_NETWORKS.has(requestedNetwork)) {
    throw new Error(
      `refusing to start: ${requestedNetwork} is a mainnet network; real money requires PAYMENT_MODE=mainnet (no silent mainnet activation)`,
    );
  }
  if (paymentMode === "mainnet" && !SETTLEABLE_MAINNET_NETWORKS.has(requestedNetwork)) {
    // This includes the Solana mainnet id: the build registers no Solana scheme,
    // so accepting it here would start a process that cannot settle anything.
    throw new Error(
      `PAYMENT_MODE=mainnet requires NETWORK in the mainnet allowlist (${[...SETTLEABLE_MAINNET_NETWORKS].join(", ")}), got ${requestedNetwork}`,
    );
  }
  if (paymentMode === "testnet" && !TESTNET_NETWORKS.has(requestedNetwork)) {
    throw new Error(`testnet payment mode requires a documented testnet network, got ${requestedNetwork}`);
  }
  if (paymentMode === "mock" && requestedNetwork !== MOCK_NETWORK) {
    throw new Error(`mock payment mode requires network ${MOCK_NETWORK}, got ${requestedNetwork}`);
  }

  // Parsed through `@x402s/shared/env` so this process and the controller
  // cannot disagree about the default; they used to (the controller defaulted
  // to true, this file to the mock mode). Mock has no economic security, so it
  // must be acknowledged explicitly rather than implied by the payment mode,
  // and real money must never be paired with the switch that accepts simulated
  // attestation and an unpinned image.
  const allowInsecureDev = envAllowInsecureDev(env);
  if (paymentMode === "mock" && !allowInsecureDev) {
    throw new Error("mock payments require ALLOW_INSECURE_DEV=true (mock payments have no economic security)");
  }
  if (paymentMode === "mainnet" && allowInsecureDev) {
    throw new Error(
      "refusing to start: PAYMENT_MODE=mainnet requires ALLOW_INSECURE_DEV=false; the insecure switch accepts simulated dev attestation and an unpinned guest image, so real payments cannot be enabled beside it",
    );
  }

  if (paymentMode === "mainnet" && !env.FACILITATOR_URL) {
    throw new Error(
      "PAYMENT_MODE=mainnet requires FACILITATOR_URL to be set explicitly (no default facilitator for real money)",
    );
  }
  const facilitatorUrl =
    env.FACILITATOR_URL ??
    (paymentMode === "mock" ? "http://127.0.0.1:3002" : "https://x402.org/facilitator");

  const payTo = env.PAY_TO ?? (paymentMode === "mock" ? MOCK_PAY_TO : "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    throw new Error("PAY_TO must be a 20-byte EVM address");
  }
  if (paymentMode !== "mock" && payTo === MOCK_PAY_TO) {
    throw new Error(`PAY_TO must be a real receiving address in ${paymentMode} mode`);
  }
  return { paymentMode, network: requestedNetwork, payTo, facilitatorUrl };
}

/**
 * Facilitator client configuration.
 *
 * The auth pair is all-or-nothing: half a CDP key would fail at the first
 * payment with an opaque 401, so it is refused at startup instead. A bearer
 * token over plaintext is a leaked credential, so the pair requires https.
 */
function parseFacilitator(env: NodeJS.ProcessEnv, facilitatorUrl: string): Pick<
  ApiConfig,
  "facilitatorTimeoutMs" | "facilitatorApiKeyId" | "facilitatorApiKeySecret"
> {
  const apiKeyId = (env.FACILITATOR_API_KEY_ID ?? "").trim();
  const apiKeySecret = (env.FACILITATOR_API_KEY_SECRET ?? "").trim();
  if ((apiKeyId.length === 0) !== (apiKeySecret.length === 0)) {
    throw new Error("FACILITATOR_API_KEY_ID and FACILITATOR_API_KEY_SECRET must be set together");
  }
  if (apiKeyId.length > 0 && !facilitatorUrl.startsWith("https://")) {
    throw new Error("FACILITATOR_API_KEY_* requires an https FACILITATOR_URL");
  }
  return {
    facilitatorTimeoutMs: int(env.FACILITATOR_TIMEOUT_MS, 20_000, 1_000, 120_000),
    ...(apiKeyId.length > 0 ? { facilitatorApiKeyId: apiKeyId } : {}),
    ...(apiKeySecret.length > 0 ? { facilitatorApiKeySecret: apiKeySecret } : {}),
  };
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
): Pick<
  ApiConfig,
  | "paymentRpcUrl"
  | "paymentUsdcAddress"
  | "paymentSettlementLookbackBlocks"
  | "paymentSettlementScanChunkBlocks"
> {
  const settings = parseChainReadSettings(env, {
    mock: paymentMode === "mock",
    network,
  });
  // Real money is never granted on a facilitator's word alone: mainnet must be
  // able to confirm the EIP-3009 nonce on chain before it grants, and before it
  // can recover a settle-then-crash. Checked here, where the RPC setting is
  // read, so the rule sits next to the value that satisfies it.
  if (paymentMode === "mainnet" && !settings.rpcUrl) {
    throw new Error(
      "PAYMENT_MODE=mainnet requires PAYMENT_RPC_URL: settlement must be verified on chain",
    );
  }
  return {
    // The scan bounds are on every path, including mock, so a misconfigured
    // deployment cannot ask for an unbounded `eth_getLogs`. The verifier also
    // caps the calls per check.
    paymentSettlementLookbackBlocks: settings.lookbackBlocks,
    paymentSettlementScanChunkBlocks: settings.chunkBlocks,
    ...(settings.rpcUrl
      ? { paymentRpcUrl: settings.rpcUrl, paymentUsdcAddress: settings.usdcAddress }
      : {}),
  };
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

/**
 * The icon a catalogue shows next to the resource.
 *
 * Optional, because a self-hosted deployment may have no public image. When it
 * is set it must be absolute: the Bazaar fetches it, so a relative path is a
 * broken listing rather than a broken image.
 */
function parseBazaarIconUrl(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.BAZAAR_ICON_URL;
  if (raw === undefined || raw === "") return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported scheme");
    }
    return raw;
  } catch {
    throw new Error(`BAZAAR_ICON_URL must be an absolute http(s) URL, got ${raw}`);
  }
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

  const facilitator = parseFacilitator(env, payment.facilitatorUrl);

  const credentials = parseCredentials(env);

  const port = int(env.PORT, 3000, 1, 65535);

  // Absolute http(s) URL, no trailing slash: the 402 challenge appends
  // `/v1/sessions` to it, and a stray slash produces a URL with a double slash.
  const publicBaseUrl = parsePublicBaseUrl(env, port);
  const bazaarIconUrl = parseBazaarIconUrl(env);

  const controllerUrl = env.CONTROLLER_URL ?? "http://127.0.0.1:3001";
  const controllerTls = parseControllerTls(env, controllerUrl);

  return {
    port,
    // Dedicated scrape listener, never the public ingress port.
    metricsPort: int(env.METRICS_PORT, DEFAULT_METRICS_PORT, 0, 65535),
    metricsHost: env.METRICS_HOST ?? "0.0.0.0",
    ...payment,
    ...facilitator,
    ...chainVerification,
    ...credentials,
    controllerUrl,
    ...(controllerTls ? { controllerTls } : {}),
    capabilityTtlSeconds: int(env.CAPABILITY_GRACE_SECONDS, 900, 60, 7200),
    maxBodyBytes: int(env.MAX_BODY_BYTES, 32 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    publicBaseUrl,
    bazaarDiscoveryEnabled: bool(env.BAZAAR_DISCOVERY_ENABLED, true),
    ...(bazaarIconUrl ? { bazaarIconUrl } : {}),
    // Receipt timeouts. They bound slow-header and slow-body clients without
    // limiting handler time, so a long-poll exec is unaffected.
    httpHeadersTimeoutMs: int(env.HTTP_HEADERS_TIMEOUT_MS, 15_000, 1_000, 120_000),
    httpRequestTimeoutMs: int(env.HTTP_REQUEST_TIMEOUT_MS, 60_000, 5_000, 600_000),
    trustProxyHops: int(env.TRUST_PROXY_HOPS, 0, 0, 8),
    // 0 disables the per-client check, which is the operator's off switch for
    // the cap as a whole: the global budget stays in force so the process can
    // still bound itself. 32 clients at the per-client default fit inside the
    // global default, so one client cannot starve a neighbour before the
    // global cap binds.
    maxConnectionsPerClient: int(env.MAX_CONNECTIONS_PER_CLIENT, 64, 0, 100_000),
    // Not 0: a global cap of zero refuses every request, which is never a
    // deliberate configuration and is far more likely to be a typo.
    maxConnectionsGlobal: int(env.MAX_CONNECTIONS_GLOBAL, 2_048, 1, 1_000_000),
    intentStaleMs: int(env.PAYMENT_INTENT_STALE_MS, 30_000, 1000, 600_000),
    createRateBurst: int(env.CREATE_RATE_BURST, 30, 1, 100_000),
    createRateRefill: int(env.CREATE_RATE_REFILL, 1, 1, 100_000),
    createIpRateBurst: int(env.CREATE_IP_RATE_BURST, 120, 1, 100_000),
    createIpRateRefill: int(env.CREATE_IP_RATE_REFILL, 10, 1, 100_000),
    readRateBurst: int(env.READ_RATE_BURST, 2_400, 1, 100_000),
    readRateRefill: int(env.READ_RATE_REFILL, 200, 1, 100_000),
    payerAllowlistEnabled: bool(env.PAYER_ALLOWLIST_ENABLED, false),
    tiers: loadTiers(env),
    platformLimits: loadPlatformLimits(env),
  };
}
