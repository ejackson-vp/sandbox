/** Shared test helpers for the x402 payment handshake. */
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/client";
import {
  MOCK_NETWORK,
  MockExactClientScheme,
  paymentKey,
} from "../../shared/src/entries/payment.js";
import { clientCommitmentMessage } from "../../shared/src/entries/crypto.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export function createMockPayingClient(account = privateKeyToAccount(generatePrivateKey())) {
  const client = x402Client.fromConfig({
    schemes: [{ network: MOCK_NETWORK, client: new MockExactClientScheme(account) }],
    spendControls: false,
  });
  const http = new x402HTTPClient(client);
  return { client, http, account, address: account.address };
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

/**
 * Challenge + pay with a single wallet, and sign the client commitment with
 * that same wallet. Returns the body to post: it carries `challengeNonce` and
 * `clientSignature`.
 */
export async function createSessionPayment(
  apiUrl: string,
  body: unknown,
): Promise<{
  header: string;
  challenge: PaymentChallenge;
  body: Record<string, unknown>;
  account: ReturnType<typeof privateKeyToAccount>;
  /** The single-use challenge value the commitment is signed over (#47). */
  challengeNonce: string;
}> {
  const account = privateKeyToAccount(generatePrivateKey());
  const { challenge } = await requestChallenge(`${apiUrl}/v1/sessions`, body);
  const challengeNonce = challengeNonceOf(challenge);
  const { client, http } = createMockPayingClient(account);
  const payload = await client.createPaymentPayload(challenge.paymentRequired as never);
  const header = http.encodePaymentSignatureHeader(payload)["PAYMENT-SIGNATURE"];
  if (!header) throw new Error("encoder produced no PAYMENT-SIGNATURE");
  const signed = body as { clientPublicKey: string; clientNonce: string };
  const clientSignature = await account.signMessage({
    message: clientCommitmentMessage({
      paymentKey: paymentKey(payload as never),
      clientPublicKey: signed.clientPublicKey,
      clientNonce: signed.clientNonce,
      challengeNonce,
    }),
  });
  return {
    header,
    challenge,
    challengeNonce,
    body: { ...(body as Record<string, unknown>), challengeNonce, clientSignature },
    account,
  };
}

/**
 * The single-use value from a challenge. Throws rather than returning a
 * placeholder: a test that signs a commitment without the server's nonce is
 * testing a protocol the server no longer speaks.
 */
export function challengeNonceOf(challenge: PaymentChallenge): string {
  const nonce = challenge.requirement.extra["challengeNonce"];
  if (typeof nonce !== "string" || !/^cn_[0-9a-f]{32}$/.test(nonce)) {
    throw new Error("challenge carries no challengeNonce; #47 is not active on this server");
  }
  return nonce;
}
