/**
 * Environment, read once at startup and refused loudly.
 *
 * An MCP server is launched by a client, not by a person, so a missing variable
 * surfaces as a dead tool in a chat window rather than a stack trace someone
 * reads. Every failure here writes one line to stderr, which is where MCP
 * clients surface server logs, and exits: a half-configured server that starts
 * and then fails on the first paid call is worse than one that never starts.
 */
import type { PaymentMode } from "@x402s/sdk";

export interface McpConfig {
  apiUrl: string;
  paymentMode: PaymentMode;
  /** The default tier when a tool call does not name one. */
  defaultTier: "short" | "standard" | "extended" | "long";
  /** Carried into every create, so a client can cap a spend in one place. */
  maxCommandSeconds: number;
}

const TIERS = ["short", "standard", "extended", "long"] as const;

function fail(message: string): never {
  process.stderr.write(`throwbox-mcp: ${message}\n`);
  process.exit(1);
}

/** Read the mode, defaulting to mainnet because that is the hosted service. */
function paymentMode(env: NodeJS.ProcessEnv): PaymentMode {
  const raw = env.PAYMENT_MODE ?? "mainnet";
  if (raw !== "mock" && raw !== "testnet" && raw !== "mainnet") {
    fail(`PAYMENT_MODE must be "mock", "testnet" or "mainnet", got ${raw}`);
  }
  return raw;
}

function tier(env: NodeJS.ProcessEnv): McpConfig["defaultTier"] {
  const raw = env.THROWBOX_TIER ?? "short";
  if (!(TIERS as readonly string[]).includes(raw)) {
    fail(`THROWBOX_TIER must be one of ${TIERS.join(", ")}, got ${raw}`);
  }
  return raw as McpConfig["defaultTier"];
}

/**
 * Validate the variables that only matter once a call is paid for.
 *
 * The SDK refuses mainnet without `CONFIRM_REAL_MONEY=yes`, and refuses any
 * real network without `EVM_PRIVATE_KEY`. Checking here means a user who
 * pastes the config without a key gets told at launch instead of at the first
 * tool call, when the agent has already promised them a result.
 */
function assertPaymentCredentials(mode: PaymentMode, env: NodeJS.ProcessEnv): void {
  if (mode === "mock") return;
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.EVM_PRIVATE_KEY ?? "")) {
    fail(
      `EVM_PRIVATE_KEY is required for ${mode} payments: an unused wallet with USDC on ${
        mode === "mainnet" ? "Base" : "Base Sepolia"
      }, hex encoded, 0x plus 64 characters`,
    );
  }
  if (mode === "mainnet" && env.CONFIRM_REAL_MONEY !== "yes") {
    fail("mainnet spends real USDC; set CONFIRM_REAL_MONEY=yes to allow it");
  }
}

export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const apiUrl = (env.THROWBOX_API_URL ?? "https://api.throwbox.dev").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(apiUrl)) {
    fail(`THROWBOX_API_URL must be an absolute http(s) URL, got ${apiUrl}`);
  }
  const mode = paymentMode(env);
  assertPaymentCredentials(mode, env);
  return {
    apiUrl,
    paymentMode: mode,
    defaultTier: tier(env),
    maxCommandSeconds: Number(env.THROWBOX_MAX_COMMAND_SECONDS ?? 300),
  };
}
