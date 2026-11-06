/**
 * Agent purchase path: the whole payment handshake is handled by
 * @x402/fetch's wrapFetchWithPayment, exactly as an autonomous agent would do.
 */
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { MOCK_NETWORK, MockExactClientScheme, TESTNET_NETWORK, formatUsd } from "@x402s/shared";
import type { Payer, PaymentMode } from "@x402s/sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export async function createAgentPayer(
  mode: PaymentMode,
  apiUrl: string,
  log: (line: string) => void,
): Promise<Payer> {
  let client: x402Client;
  let address: string;

  if (mode === "mock") {
    const account = privateKeyToAccount(generatePrivateKey());
    client = x402Client.fromConfig({
      schemes: [{ network: MOCK_NETWORK, client: new MockExactClientScheme(account) }],
      spendControls: false,
    });
    address = account.address;
  } else {
    const pk = process.env.EVM_PRIVATE_KEY;
    if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      throw new Error("testnet payment mode requires EVM_PRIVATE_KEY");
    }
    const account = privateKeyToAccount(pk as `0x${string}`);
    client = x402Client.fromConfig({
      schemes: [{ network: TESTNET_NETWORK, client: new ExactEvmScheme(account) }],
    });
    address = account.address;
  }

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

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
    mode,
    async createSession(baseUrl, body) {
      log(`discovered price: ${priceUsd}`);
      log("signing x402 payment and retrying request");
      const response = await fetchWithPayment(`${baseUrl}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      } as RequestInit);
      log(`server responded ${response.status}`);
      return { response, priceUsd, network, mode, payer: address };
    },
  };
}
