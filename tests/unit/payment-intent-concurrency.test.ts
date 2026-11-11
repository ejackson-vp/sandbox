/**
 * Real multi-process claim/reclaim/complete race for payment intents.
 *
 * Each worker owns a separate SQLite connection, so this exercises the
 * BEGIN IMMEDIATE serialisation and the claim-token fence rather than two calls
 * on one connection. The stale owner must never settle; after the live owner
 * settles, the stale owner receives the winning session instead of an error.
 */
import { afterEach, describe, expect, it } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../controller/src/store.js";

const WORKER = join(process.cwd(), "tests/unit/helpers/intent-worker.ts");
const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function waitFor(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker timeout waiting for ${type}`)), 20_000);
    const handler = (message: Record<string, unknown>) => {
      if (message.type === "fatal") {
        clearTimeout(timer);
        child.off("message", handler);
        reject(new Error(String(message.error ?? "worker startup failed")));
        return;
      }
      if (message.type !== type) return;
      clearTimeout(timer);
      child.off("message", handler);
      resolve(message);
    };
    child.on("message", handler);
    child.once("error", reject);
  });
}

function startWorker(dbPath: string): ChildProcess {
  const child = fork(WORKER, [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (process.env.DEBUG_WORKERS) process.stderr.write(`[worker] ${chunk}`);
  });
  children.push(child);
  child.send({ type: "init", dbPath });
  return child;
}

describe("real SQLite payment-intent concurrency", () => {
  it("fences a reclaimed owner and hands both completions the same session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-intent-concurrent-"));
    dirs.push(dir);
    const dbPath = join(dir, "controller.db");
    new Store(dbPath).close();

    const workers = [startWorker(dbPath), startWorker(dbPath)];
    await Promise.all(workers.map((worker) => waitFor(worker, "ready")));

    const paymentKey = "c".repeat(64);
    const specHash = "a".repeat(64);

    // 1. Both workers race the claim. One inserts the intent, the other
    //    reclaims it (staleMs = -1 forces the crash path).
    const claims = await Promise.all(
      workers.map((worker, i) => {
        worker.send({ type: "claim", opId: `claim-${i}`, paymentKey, specHash, staleMs: -1 });
        return waitFor(worker, "result");
      }),
    );
    expect(claims.map((c) => c.status)).toEqual(["claimed", "claimed"]);
    const staleIndex = claims.findIndex((c) => c.recovered === false);
    const liveIndex = claims.findIndex((c) => c.recovered === true);
    expect(staleIndex).toBeGreaterThanOrEqual(0);
    expect(liveIndex).toBeGreaterThanOrEqual(0);
    expect(staleIndex).not.toBe(liveIndex);
    const staleToken = String(claims[staleIndex]?.token);
    const liveToken = String(claims[liveIndex]?.token);
    expect(staleToken).not.toBe(liveToken);

    // 2. The stale owner cannot settle while the live owner holds the claim.
    workers[staleIndex]?.send({
      type: "complete",
      opId: "stale-before",
      paymentKey,
      token: staleToken,
      sessionId: "sbx_0000000000000000000000a1",
    });
    const staleBefore = await waitFor(workers[staleIndex]!, "result");
    expect(staleBefore).toMatchObject({ ok: false, error: "PaymentClaimLostError" });

    const probe = new Store(dbPath);
    try {
      expect(probe.countSessions()).toBe(0);
      expect(probe.countPayments()).toBe(0);
      expect((await probe.getPaymentIntent(paymentKey))?.status).toBe("claimed");
    } finally {
      probe.close();
    }

    // 3. Both workers complete concurrently with the live token and different
    //    session ids. Exactly one creates the session; the other is idempotent.
    const sessionIds = ["sbx_0000000000000000000000b1", "sbx_0000000000000000000000b2"];
    const completions = await Promise.all(
      workers.map((worker, i) => {
        worker.send({
          type: "complete",
          opId: `complete-${i}`,
          paymentKey,
          token: liveToken,
          sessionId: sessionIds[i]!,
        });
        return waitFor(worker, "result");
      }),
    );
    const created = completions.filter((c) => c.ok === true && c.created === true);
    const idempotent = completions.filter((c) => c.ok === true && c.created === false);
    expect(created).toHaveLength(1);
    expect(idempotent).toHaveLength(1);
    const winner = String(created[0]?.sessionId);
    expect(idempotent[0]?.sessionId).toBe(winner);
    expect(sessionIds).toContain(winner);

    // 4. The stale owner now learns the outcome: the winning session, no error.
    workers[staleIndex]?.send({
      type: "complete",
      opId: "stale-after",
      paymentKey,
      token: staleToken,
      sessionId: "sbx_0000000000000000000000a2",
    });
    const staleAfter = await waitFor(workers[staleIndex]!, "result");
    expect(staleAfter).toMatchObject({ ok: true, created: false, sessionId: winner });

    const final = new Store(dbPath);
    try {
      expect(final.countSessions()).toBe(1);
      expect(final.countPayments()).toBe(1);
      expect((await final.getSession(winner))?.paymentKey).toBe(paymentKey);
      expect((await final.getLedgerBySession(winner))?.status).toBe("SETTLED");
      expect(await final.getPaymentIntent(paymentKey)).toMatchObject({
        status: "settled",
        sessionId: winner,
        claimToken: null,
      });
    } finally {
      final.close();
    }
  }, 30_000);
});
