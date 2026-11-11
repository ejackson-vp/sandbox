/**
 * Agent purchase path.
 *
 * The agent does the whole handshake itself: discover the challenge, sign the
 * payment, prove the client commitment with the same wallet, retry. It uses the
 * SDK payer so the commitment signing cannot drift from the normal client path.
 */
import { createPayer, type Payer, type PaymentMode } from "@x402s/sdk";
import { MOCK_NETWORK, TESTNET_NETWORK } from "@x402s/shared/payment";
import { formatUsd } from "@x402s/shared/money";

export async function createAgentPayer(
  mode: PaymentMode,
  apiUrl: string,
  log: (line: string) => void,
): Promise<Payer> {
  const payer = createPayer(mode);

  let priceUsd = "unknown";
  let network: string = mode === "mock" ? MOCK_NETWORK : TESTNET_NETWORK;
  try {
    const pricing = (await (await fetch(`${apiUrl}/v1/pricing`)).json()) as {
      tiers?: Record<string, { priceUsd?: string }>;
      network?: string;
    };
    priceUsd = pricing.tiers?.standard?.priceUsd ?? formatUsd("50000");
    network = pricing.network ?? network;
  } catch {
    /* display only */
  }

  return {
    mode: payer.mode,
    signMessage: (message) => payer.signMessage(message),
    async createSession(baseUrl, body) {
      log(`discovered price: ${priceUsd}`);
      log("signing x402 payment and retrying request");
      const paid = await payer.createSession(baseUrl, body);
      log(`server responded ${paid.response.status}`);
      return { ...paid, priceUsd, network };
    },
  };
}
