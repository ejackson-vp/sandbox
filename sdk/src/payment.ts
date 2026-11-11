/**
 * x402 payment client for the SDK.
 *
 * The buyer performs the protocol manually so callers can surface the 402
 * challenge, price and settlement result. Payload creation and header encoding
 * use the official @x402 packages.
 *
 * Every create takes the 402 round trip. The server issues a single-use
 * `challengeNonce` with each challenge and the wallet signature covers it, so a
 * cached challenge would be unusable after its first (or any) use. The previous
 * challenge cache existed to save one round trip; correctness costs it back.
 *
 * A rejected challenge is retried once with the *same* payment payload and the
 * fresh nonce from that 402. Reusing the payload keeps the payment key stable,
 * which is what makes a retry after a lost response recover the existing
 * entitlement instead of paying twice.
 */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { clientCommitmentMessage, isChallengeNonce } from "@x402s/shared/crypto";
import {
  MOCK_NETWORK,
  MockExactClientScheme,
  TESTNET_NETWORK,
  paymentKey,
} from "@x402s/shared/payment";
import { formatUsd } from "@x402s/shared/money";
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

/** A parsed 402: the requirements to pay and the nonce to sign over. */
interface Challenge {
  required: PaymentRequired;
  requirement: PaymentRequirements;
  nonce: string;
}

export function createPayer(mode: PaymentMode): Payer {
  const { client, address, signMessage } = buildClient(mode);
  const httpClient = new x402HTTPClient(client);

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

      /** Read the challenge, its price and its single-use nonce from a 402. */
      const challengeOf = (response: Response): Challenge | { error: string } => {
        if (!response.headers.get("payment-required")) {
          return { error: "server returned 402 without a PAYMENT-REQUIRED header" };
        }
        let required: PaymentRequired;
        try {
          required = httpClient.getPaymentRequiredResponse(
            (name) => response.headers.get(name) ?? undefined,
          );
        } catch (err) {
          return { error: `invalid payment requirements: ${(err as Error).message}` };
        }
        const requirement = required.accepts[0];
        if (!requirement) return { error: "server advertised no payment options" };
        const nonce = requirement.extra?.["challengeNonce"];
        if (!isChallengeNonce(nonce)) {
          // An older server, or one that failed to mint a nonce: refuse rather
          // than sign a commitment the server will not verify.
          return { error: "server did not issue a challenge nonce" };
        }
        return { required, requirement, nonce };
      };

      const errorOf = async (response: Response): Promise<string> => {
        try {
          const parsed = (await response.clone().json()) as { error?: unknown };
          return typeof parsed.error === "string" ? parsed.error : "";
        } catch {
          return "";
        }
      };

      /**
       * Sign the commitment for this challenge and post the payment. A caller
       * that passes `payload` reuses it, so the payment key does not change.
       */
      const pay = async (challenge: Challenge, payload?: PaymentPayload) => {
        const created = payload ?? (await client.createPaymentPayload(challenge.required));
        const paymentHeaders = httpClient.encodePaymentSignatureHeader(created);
        const commitment = await signMessage(
          clientCommitmentMessage({
            paymentKey: paymentKey(created as never),
            clientPublicKey: body.clientPublicKey,
            clientNonce: body.clientNonce,
            challengeNonce: challenge.nonce,
          }),
        );
        const response = await fetch(url, {
          method: "POST",
          headers: { ...headers, ...paymentHeaders },
          body: JSON.stringify({
            ...body,
            challengeNonce: challenge.nonce,
            clientSignature: commitment,
          }),
          signal: AbortSignal.timeout(120_000),
        });
        return { response, payload: created };
      };

      const unpaid = (response: Response, priceUsd: string, network: string): PaidResponse => ({
        response,
        priceUsd,
        network,
        mode,
        payer: address,
      });

      let response = await request();
      if (response.status !== 402) {
        return unpaid(response, "unknown", mode === "mock" ? MOCK_NETWORK : TESTNET_NETWORK);
      }

      const challenged = challengeOf(response);
      if ("error" in challenged) {
        return { ...unpaid(response, "unknown", "unknown"), paymentError: challenged.error };
      }

      let attempt = await pay(challenged);
      // One retry, and only for a challenge problem: the 402 carries a fresh
      // nonce, and reusing the payload keeps the payment key (so a payment that
      // already settled recovers its entitlement instead of being charged again).
      const firstError = attempt.response.status === 402 ? await errorOf(attempt.response) : "";
      if (firstError.startsWith("challenge_nonce")) {
        const renewed = challengeOf(attempt.response);
        if (!("error" in renewed)) attempt = await pay(renewed, attempt.payload);
      }

      let paymentError: string | undefined;
      if (attempt.response.status === 402) {
        const code = await errorOf(attempt.response);
        paymentError = code || "payment_rejected";
      }

      return {
        ...unpaid(
          attempt.response,
          formatUsd(challenged.requirement.amount),
          challenged.requirement.network,
        ),
        ...(paymentError ? { paymentError } : {}),
      };
    },
  };
}
