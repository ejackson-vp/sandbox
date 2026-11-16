/**
 * What `createApp` is composed from.
 *
 * The interface lives here rather than in `server.ts` so the boot modules can
 * take it without importing the module that imports them. Three fields are
 * injectable because the unit suite drives the real app with a fake facilitator
 * and a fake controller (`tests/unit/api-app-shell.test.ts`); everything else
 * is built from `config`.
 */
import type { x402ResourceServer } from "@x402/core/server";
import type { SettlementLookup } from "@x402s/shared/runtime";
import type { ChainSettlementVerifier } from "@x402s/shared/settlement";
import type { ApiConfig } from "../config.js";
import type { ControllerClient } from "../controller-client.js";

export interface ApiDeps {
  config: ApiConfig;
  controller: ControllerClient;
  /** Injectable for tests: bypasses HTTP facilitator setup. */
  resourceServer?: x402ResourceServer;
  /** Injectable for tests. */
  settlementLookup?: SettlementLookup;
  /** Injectable for tests: bypasses the viem client. */
  settlementVerifier?: ChainSettlementVerifier;
}
