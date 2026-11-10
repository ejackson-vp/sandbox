/**
 * x402 payment client for the SDK.
 *
 * The buyer performs the protocol manually so callers can surface the 402
 * challenge, price and settlement result. Payload creation and header encoding
 * use the official @x402 packages.
 */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { clientCommitmentMessage } from "@x402s/shared/crypto";
import {
  MOCK_NETWORK,
  MockExactClientScheme,
  TESTNET_NETWORK,
  formatUsd,
  paymentKey,
} from "@x402s/shared/payment";
import type { CreateSessionRequest } from "@x402s/shared/protocol";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export type PaymentMode = "mock" | "testnet";

export interface PaidResponse {
  response: Response;
  priceUsd: string;
  network: string;
  mode: PaymentMode;
  payer: string;
  paymentError?: string;
}

export interface Payer {
  mode: PaymentMode;
  /** Sign the client commitment with the paying wallet. */
  signMessage(message: string): Promise<`0x${string}`>;
  createSession(apiUrl: string, body: CreateSessionRequest): Promise<PaidResponse>;
}

function buildClient(mode: PaymentMode): {
  client: x402Client;
  address: string;
  signMessage: (message: string) => Promise<`0x${string}`>;
} {
  if (mode === "mock") {
    // Ephemeral wallet: mock payments have no economic value.
    const account = privateKeyToAccount(generatePrivateKey());
    const client = x402Client.fromConfig({
      schemes: [{ network: MOCK_NETWORK, client: new MockExactClientScheme(account) }],
      spendControls: false,
    });
    return {
      client,
      address: account.address,
      signMessage: (message) => account.signMessage({ message }),
    };
  }

  const pk = process.env.EVM_PRIVATE_KEY;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error("testnet payment mode requires EVM_PRIVATE_KEY (a funded Base Sepolia wallet)");
  }
  const account = privateKeyToAccount(pk as `0x${string}`);
  const client = x402Client.fromConfig({
    schemes: [{ network: TESTNET_NETWORK, client: new ExactEvmScheme(account) }],
  });
  return {
    client,
    address: account.address,
    signMessage: (message) => account.signMessage({ message }),
  };
}

export function createPayer(mode: PaymentMode): Payer {
  const { client, address, signMessage } = buildClient(mode);
  const httpClient = new x402HTTPClient(client);
  /**
   * A challenge is a function of the session spec, not of the request. Caching
   * it lets repeat creates skip the unauthenticated 402 round trip: send the
   * payment on the first request and only take the challenge path when the
   * server rejects it (a price or payTo change) or when it is not cached yet.
   */
  const challenges = new Map<string, PaymentRequired>();
  const cacheKey = (apiUrl: string, body: CreateSessionRequest): string =>
    JSON.stringify([
      apiUrl,
      body.tier ?? null,
      body.durationSeconds ?? null,
      body.cpuMillis ?? null,
      body.memoryMiB ?? null,
      body.diskMiB ?? null,
      body.baselineCpuMillis ?? null,
      body.baselineMemoryMiB ?? null,
      body.maxLifetimeSeconds ?? null,
    ]);

  return {
    mode,
    signMessage,
    async createSession(apiUrl, body) {
      const url = `${apiUrl.replace(/\/$/, "")}/v1/sessions`;
      const headers = { "content-type": "application/json" };
      const request = () =>
        fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        });
      const pay = async (required: PaymentRequired): Promise<Response> => {
        const payload = await client.createPaymentPayload(required);
        const paymentHeaders = httpClient.encodePaymentSignatureHeader(payload);
        // Prove the client key is controlled by the wallet that pays. The
        // receipt alone then cannot be replayed by another client.
        const commitment = await signMessage(
          clientCommitmentMessage({
            paymentKey: paymentKey(payload as never),
            clientPublicKey: body.clientPublicKey,
            clientNonce: body.clientNonce,
          }),
        );
        return fetch(url, {
          method: "POST",
          headers: { ...headers, ...paymentHeaders },
          body: JSON.stringify({ ...body, clientSignature: commitment }),
          signal: AbortSignal.timeout(120_000),
        });
      };
      const paid = (response: Response, required: PaymentRequired): PaidResponse => {
        const requirement = required.accepts[0]!;
        return {
          response,
          priceUsd: formatUsd(requirement.amount),
          network: requirement.network,
          mode,
          payer: address,
        };
      };

      const key = cacheKey(apiUrl, body);
      const cached = challenges.get(key);
      if (cached) {
        const response = await pay(cached);
        if (response.ok) return paid(response, cached);
        if (response.status !== 402) {
          return {
            response,
            priceUsd: "unknown",
            network: cached.accepts[0]?.network ?? "unknown",
            mode,
            payer: address,
          };
        }
        // Rejected or stale: forget it and take the challenge path once.
        challenges.delete(key);
      }

      let response = await request();
      if (response.status !== 402) {
        return {
          response,
          priceUsd: "unknown",
          network: mode === "mock" ? MOCK_NETWORK : TESTNET_NETWORK,
          mode,
          payer: address,
        };
      }

      const requiredHeader = response.headers.get("payment-required");
      if (!requiredHeader) {
        return {
          response,
          priceUsd: "unknown",
          network: "unknown",
          mode,
          payer: address,
          paymentError: "server returned 402 without a PAYMENT-REQUIRED header",
        };
      }

      let paymentRequired;
      try {
        paymentRequired = httpClient.getPaymentRequiredResponse((name) => response.headers.get(name) ?? undefined);
      } catch (err) {
        return {
          response,
          priceUsd: "unknown",
          network: "unknown",
          mode,
          payer: address,
          paymentError: `invalid payment requirements: ${(err as Error).message}`,
        };
      }

      const requirement = paymentRequired.accepts[0];
      if (!requirement) {
        return {
          response,
          priceUsd: "unknown",
          network: "unknown",
          mode,
          payer: address,
          paymentError: "server advertised no payment options",
        };
      }

      if (challenges.size >= 64) challenges.clear();
      challenges.set(key, paymentRequired);
      response = await pay(paymentRequired);

      let paymentError: string | undefined;
      if (response.status === 402) {
        try {
          const bodyJson = (await response.clone().json()) as { error?: string };
          paymentError = bodyJson.error ?? "payment_rejected";
        } catch {
          paymentError = "payment_rejected";
        }
      }

      return {
        response,
        priceUsd: formatUsd(requirement.amount),
        network: requirement.network,
        mode,
        payer: address,
        ...(paymentError ? { paymentError } : {}),
      };
    },
  };
}
