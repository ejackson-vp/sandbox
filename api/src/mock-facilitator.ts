/**
 * Deterministic mock x402 facilitator.
 *
 * Implements the x402 v2 facilitator HTTP contract used by @x402/core's
 * HTTPFacilitatorClient:
 *   GET  /supported
 *   POST /verify
 *   POST /settle
 *
 * Verification is real (EIP-712 signature recovery, recipient/amount/network
 * checks, validity window) but settlement is simulated: there is no chain, no
 * funds, and no economic security. Nonce claims are stored in SQLite so replay
 * is rejected atomically across concurrent requests.
 */
import express from "express";
import { DatabaseSync } from "node:sqlite";
import { verifyTypedData } from "viem";
import { x402Facilitator } from "@x402/core/facilitator";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  MockExactFacilitatorScheme,
  MOCK_NETWORK,
  type MockNonceStore,
} from "@x402s/shared";
import { log } from "./log.js";

class SqliteNonceStore implements MockNonceStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mock_nonces (
        nonce TEXT PRIMARY KEY,
        payer TEXT NOT NULL,
        payment_key TEXT NOT NULL UNIQUE,
        amount TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  async claimNonce(
    nonce: string,
    meta: { payer: string; paymentKey: string; amount: string },
  ): Promise<boolean> {
    try {
      this.db
        .prepare(
          "INSERT INTO mock_nonces (nonce, payer, payment_key, amount, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(nonce.toLowerCase(), meta.payer, meta.paymentKey, meta.amount, Date.now());
      return true;
    } catch {
      return false; // UNIQUE violation => replay
    }
  }
}

export interface MockFacilitatorHandle {
  app: express.Express;
  close(): void;
  reset(): void;
  setFailSettle(enabled: boolean): void;
}

export interface MockFacilitatorOptions {
  dbPath?: string;
  allowControl?: boolean;
}

export async function createMockFacilitator(opts: MockFacilitatorOptions = {}): Promise<MockFacilitatorHandle> {
  const db = new DatabaseSync(opts.dbPath ?? ":memory:");;
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
  const store = new SqliteNonceStore(db);

  const scheme = new MockExactFacilitatorScheme(
    { store, network: MOCK_NETWORK },
    verifyTypedData as never,
  );

  const facilitator = new x402Facilitator();
  facilitator.register(MOCK_NETWORK, scheme);

  let failSettle = false;

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, network: MOCK_NETWORK, settlement: "mock-offchain" });
  });

  app.get("/supported", (_req, res) => {
    const supported = facilitator.getSupported();
    res.json({
      ...supported,
      kinds: supported.kinds.map((k) => ({ ...k, x402Version: 2 })),
    });
  });

  app.post("/verify", async (req, res) => {
    const { paymentPayload, paymentRequirements } = req.body ?? {};
    if (!paymentPayload || !paymentRequirements) {
      res.status(400).json({ isValid: false, invalidReason: "bad_request" });
      return;
    }
    const result = await facilitator.verify(paymentPayload, paymentRequirements);
    log.info("mock_facilitator_verify", {
      isValid: result.isValid,
      reason: result.invalidReason,
      payer: result.payer,
    });
    res.status(200).json(result);
  });

  app.post("/settle", async (req, res) => {
    const { paymentPayload, paymentRequirements } = req.body ?? {};
    if (!paymentPayload || !paymentRequirements) {
      res.status(400).json({ success: false, errorReason: "bad_request", transaction: "", network: MOCK_NETWORK });
      return;
    }
    if (failSettle) {
      log.warn("mock_facilitator_settle_forced_failure");
      res.status(200).json({
        success: false,
        errorReason: "mock_settle_failure",
        errorMessage: "settlement failure injected by test control",
        transaction: "",
        network: MOCK_NETWORK,
      });
      return;
    }
    const result = await facilitator.settle(paymentPayload, paymentRequirements);
    log.info("mock_facilitator_settle", {
      success: result.success,
      reason: result.errorReason,
      transaction: result.transaction,
    });
    res.status(200).json(result);
  });

  if (opts.allowControl ?? true) {
    // Test-only control surface. Never expose this facilitator publicly.
    app.post("/control/fail-settle", (req, res) => {
      failSettle = Boolean(req.body?.enabled);
      res.json({ failSettle });
    });
    app.post("/control/reset", (_req, res) => {
      failSettle = false;
      db.exec("DELETE FROM mock_nonces;");
      res.json({ ok: true });
    });
    app.get("/control/nonces", (_req, res) => {
      const rows = db.prepare("SELECT nonce, payer, amount, created_at FROM mock_nonces").all();
      res.json({ count: rows.length, nonces: rows.map((r) => (r as { nonce: string }).nonce) });
    });
  }

  return {
    app,
    close: () => db.close(),
    reset: () => {
      failSettle = false;
      db.exec("DELETE FROM mock_nonces;");
    },
    setFailSettle: (v: boolean) => {
      failSettle = v;
    },
  };
}

/** Used by integration tests: an in-process facilitator client. */
export function mockFacilitatorClient(url: string): HTTPFacilitatorClient {
  return new HTTPFacilitatorClient({ url });
}
