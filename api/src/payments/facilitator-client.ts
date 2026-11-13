/**
 * The facilitator port: verify and settle one x402 payment.
 *
 * This is the deployment's own client rather than @x402/core's, for three
 * reasons that are policy, not transport:
 *
 *  - **Timeouts are named.** A settle call has its own budget, shorter than the
 *    client's patience, so a lost answer becomes the documented `unknown`
 *    outcome instead of a request that hangs until the socket gives up.
 *  - **Only safe calls are retried.** `verify` and `getSupported` are reads, so
 *    a 5xx or a dropped connection is retried a bounded number of times.
 *    `settle` is never retried here: the EIP-3009 nonce makes it idempotent at
 *    the facilitator, and a duplicate call spends the recovery budget on work
 *    the chain can already answer (ADR 0011). A lost settle is resolved by the
 *    on-chain verifier, not by sending it again.
 *  - **Errors carry no secrets.** A message names the operation and the status
 *    code. Response bodies are parsed for the protocol's own refusal fields
 *    (`isValid`, `success`, `errorReason`) and never quoted into a log line or
 *    an exception, because a facilitator echo can contain the payment payload.
 *
 * The wire contract is x402 v2: `POST {base}/verify` and `POST {base}/settle`
 * with `{ x402Version, paymentPayload, paymentRequirements }`. The CDP
 * facilitator serves the same contract under
 * `https://api.cdp.coinbase.com/platform/v2/x402`.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { z } from "zod";
import { log } from "@x402s/shared/runtime";
import type { ApiConfig } from "../config.js";
import {
  cdpFacilitatorAuth,
  noFacilitatorAuth,
  type FacilitatorAuth,
} from "./facilitator-auth.js";

/** Mirrors the response shapes @x402/core's own client accepts. */
const verifyResponseSchema = z.object({
  isValid: z.boolean(),
  invalidReason: z.string().nullish(),
  invalidMessage: z.string().nullish(),
  payer: z.string().nullish(),
});

const settleResponseSchema = z.object({
  success: z.boolean(),
  errorReason: z.string().nullish(),
  errorMessage: z.string().nullish(),
  payer: z.string().nullish(),
  transaction: z.string(),
  network: z.string(),
  amount: z.string().nullish(),
});

const supportedResponseSchema = z.object({
  kinds: z.array(
    z.object({
      x402Version: z.number(),
      scheme: z.string(),
      network: z.string(),
      extra: z.record(z.string(), z.unknown()).nullish(),
    }),
  ),
  extensions: z.array(z.string()).default([]),
  signers: z.record(z.string(), z.array(z.string())).default({}),
});

/** A facilitator answered, and the answer was not the protocol. */
export class FacilitatorError extends Error {
  constructor(
    readonly operation: "verify" | "settle" | "supported",
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "FacilitatorError";
  }
}

export interface FacilitatorClientOptions {
  /** Base URL without a trailing slash, e.g. `https://x402.org/facilitator`. */
  baseUrl: string;
  auth?: FacilitatorAuth;
  /** Per-attempt budget. A settle that exceeds it is `unknown`, not a refusal. */
  timeoutMs?: number;
  /** Retries for `verify` and `getSupported` only. Settle is never retried. */
  retries?: number;
  retryBaseMs?: number;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 200;
/** A control-plane body is small; anything larger is not a facilitator answer. */
const MAX_BODY_BYTES = 256 * 1024;

/** Statuses worth retrying for a read. 4xx other than 408/429 is a refusal. */
function retryable(status: number | null): boolean {
  return status === null || status === 408 || status === 429 || status >= 500;
}

export class X402FacilitatorClient implements FacilitatorClient {
  private readonly baseUrl: string;
  private readonly auth: FacilitatorAuth;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBaseMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: FacilitatorClientOptions) {
    // Trailing slashes are trimmed with a loop, not `/\/+$/`: a regex over an
    // operator-supplied string is a CodeQL polynomial-regex finding, and the
    // loop is both linear and obvious.
    let baseUrl = options.baseUrl;
    while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
    this.baseUrl = baseUrl;
    this.auth = options.auth ?? noFacilitatorAuth();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => delay(ms));
  }

  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    // A verify is a read: retrying it cannot move money.
    const { status, body } = await this.send("verify", paymentPayload, paymentRequirements, true);
    const parsed = verifyResponseSchema.safeParse(body);
    if (parsed.success) {
      return {
        isValid: parsed.data.isValid,
        ...(parsed.data.invalidReason ? { invalidReason: parsed.data.invalidReason } : {}),
        ...(parsed.data.invalidMessage ? { invalidMessage: parsed.data.invalidMessage } : {}),
        ...(parsed.data.payer ? { payer: parsed.data.payer } : {}),
      };
    }
    throw new FacilitatorError("verify", status, `facilitator verify answered ${status ?? "no status"}`);
  }

  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    // Deliberately no retry. See the module header and ADR 0011.
    const { status, body } = await this.send("settle", paymentPayload, paymentRequirements, false);
    const parsed = settleResponseSchema.safeParse(body);
    if (parsed.success) {
      return {
        success: parsed.data.success,
        transaction: parsed.data.transaction,
        network: parsed.data.network as SettleResponse["network"],
        ...(parsed.data.errorReason ? { errorReason: parsed.data.errorReason } : {}),
        ...(parsed.data.errorMessage ? { errorMessage: parsed.data.errorMessage } : {}),
        ...(parsed.data.payer ? { payer: parsed.data.payer } : {}),
        ...(parsed.data.amount ? { amount: parsed.data.amount } : {}),
      };
    }
    throw new FacilitatorError("settle", status, `facilitator settle answered ${status ?? "no status"}`);
  }

  async getSupported(): Promise<SupportedResponse> {
    const { status, body } = await this.send("supported", undefined, undefined, true);
    const parsed = supportedResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new FacilitatorError(
        "supported",
        status,
        `facilitator supported answered ${status ?? "no status"}`,
      );
    }
    return {
      kinds: parsed.data.kinds.map((kind) => ({
        x402Version: kind.x402Version,
        scheme: kind.scheme,
        network: kind.network,
        ...(kind.extra ? { extra: kind.extra } : {}),
      })),
      extensions: parsed.data.extensions,
      signers: parsed.data.signers,
    } as SupportedResponse;
  }

  /**
   * One request, with bounded retries when the caller allows them.
   *
   * Returns the status and parsed body for every HTTP answer, including a
   * non-2xx one, so the caller can read the protocol's own refusal fields. It
   * throws only when there is no answer at all (network, timeout, unreadable
   * body), which is the `unknown` case.
   */
  private async send(
    operation: "verify" | "settle" | "supported",
    paymentPayload: PaymentPayload | undefined,
    paymentRequirements: PaymentRequirements | undefined,
    mayRetry: boolean,
  ): Promise<{ status: number; body: unknown }> {
    const attempts = mayRetry ? this.retries + 1 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        await this.sleep(this.retryBaseMs * 2 ** (attempt - 1));
      }
      const url = new URL(`${this.baseUrl}/${operation}`);
      // `supported` is a read: x402 v2 serves it as `GET`, and both the mock
      // facilitator and every real one reject a POST here. Getting this wrong
      // fails the resource server's initialize step, which surfaces as "no
      // supported payment kinds loaded from any facilitator" at start-up.
      const method = operation === "supported" ? "GET" : "POST";
      try {
        const response = await this.fetchImpl(url, {
          method,
          headers: {
            ...(method === "POST" ? { "content-type": "application/json" } : {}),
            ...this.auth.headers(method, url),
          },
          ...(method === "POST"
            ? {
                body: JSON.stringify({
                  x402Version: paymentPayload?.x402Version ?? 2,
                  ...(paymentPayload ? { paymentPayload } : {}),
                  ...(paymentRequirements ? { paymentRequirements } : {}),
                }),
              }
            : {}),
          redirect: "follow",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = await readBounded(response);
        if (response.ok || !retryable(response.status)) {
          return { status: response.status, body: parseJson(text) };
        }
        lastError = new FacilitatorError(
          operation,
          response.status,
          `facilitator ${operation} answered ${response.status}`,
        );
        log.warn("facilitator_retryable_status", {
          operation,
          status: response.status,
          attempt: attempt + 1,
        });
      } catch (err) {
        // No answer at all: timeout, DNS, reset, or a body over the bound.
        lastError = err;
        log.warn("facilitator_call_failed", {
          operation,
          attempt: attempt + 1,
          error: (err as Error).message,
        });
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new FacilitatorError(operation, null, `facilitator ${operation} produced no answer`);
  }
}

/** Read a body with a hard bound, so a hostile facilitator cannot exhaust memory. */
async function readBounded(response: Response): Promise<string> {
  const text = await response.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new Error("facilitator response exceeded the body bound");
  }
  return text;
}

function parseJson(text: string): unknown {
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Build the client for this deployment.
 *
 * x402.org is the testnet default and the mock facilitator is the local one; a
 * CDP key pair switches authentication on and is only accepted over https,
 * because a bearer token over plaintext is a leaked credential.
 */
export function createFacilitatorClient(
  config: Pick<
    ApiConfig,
    "facilitatorUrl" | "facilitatorTimeoutMs" | "facilitatorApiKeyId" | "facilitatorApiKeySecret"
  >,
): X402FacilitatorClient {
  const auth =
    config.facilitatorApiKeyId && config.facilitatorApiKeySecret
      ? cdpFacilitatorAuth(config.facilitatorApiKeyId, config.facilitatorApiKeySecret)
      : noFacilitatorAuth();
  return new X402FacilitatorClient({
    baseUrl: config.facilitatorUrl,
    auth,
    timeoutMs: config.facilitatorTimeoutMs,
  });
}
