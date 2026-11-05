/** Shared test helpers for the x402 payment handshake. */
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/client";
import { MOCK_NETWORK, MockExactClientScheme } from "../../shared/src/index.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export function createMockPayingClient(account = privateKeyToAccount(generatePrivateKey())) {
  const client = x402Client.fromConfig({
    schemes: [{ network: MOCK_NETWORK, client: new MockExactClientScheme(account) }],
    spendControls: false,
  });
  const http = new x402HTTPClient(client);
  return { client, http, address: account.address };
}

export interface PaymentChallenge {
  paymentRequired: unknown;
  requirement: {
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra: Record<string, unknown>;
  };
}

/** Performs the initial unpaid request and returns the decoded challenge. */
export async function requestChallenge(
  url: string,
  body: unknown,
): Promise<{ response: Response; challenge: PaymentChallenge }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const { http } = createMockPayingClient();
  const header = response.headers.get("payment-required");
  if (!header) throw new Error(`no PAYMENT-REQUIRED header (status ${response.status})`);
  const paymentRequired = http.getPaymentRequiredResponse((name) => response.headers.get(name) ?? undefined);
  const requirement = (paymentRequired as { accepts: PaymentChallenge["requirement"][] }).accepts[0];
  if (!requirement) throw new Error("no accepts entry");
  return { response, challenge: { paymentRequired, requirement } };
}

/** Signs the challenge and returns the PAYMENT-SIGNATURE header value. */
export async function signChallenge(challenge: PaymentChallenge): Promise<string> {
  const { client, http } = createMockPayingClient();
  const payload = await client.createPaymentPayload(challenge.paymentRequired as never);
  const headers = http.encodePaymentSignatureHeader(payload);
  const value = headers["PAYMENT-SIGNATURE"];
  if (!value) throw new Error("encoder produced no PAYMENT-SIGNATURE");
  return value;
}

export async function createSandboxPayment(
  apiUrl: string,
  body: unknown,
): Promise<{ header: string; challenge: PaymentChallenge }> {
  const { challenge } = await requestChallenge(`${apiUrl}/v1/sandboxes`, body);
  const header = await signChallenge(challenge);
  return { header, challenge };
}
