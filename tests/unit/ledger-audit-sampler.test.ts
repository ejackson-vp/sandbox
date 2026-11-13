/**
 * The ledger audit sampler's clock contract.
 *
 * The gauges themselves are pinned next to the pure audit. This file is about
 * time: one pass on start, one per interval, no queued pass behind a slow read,
 * and a freshness gauge that keeps rising while reads fail. Fake timers only;
 * nothing here waits five minutes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetricsRegistry } from "../../shared/src/metrics.js";
import { createLedgerAuditSampler } from "../../controller/src/ledger-audit-sampler.js";

const INTERVAL_MS = 300_000;
const T0 = 1_700_000_000_000;

function cleanSnapshot() {
  return { intents: [], liveRefunds: [], sessions: [] };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ledger audit sampler", () => {
  it("samples on start and then once per interval", async () => {
    vi.useFakeTimers();
    const registry = new MetricsRegistry({ cacheMs: 0 });
    let clock = T0;
    let reads = 0;
    const sampler = createLedgerAuditSampler({
      store: {
        readLedgerAudit: async () => {
          reads += 1;
          return cleanSnapshot();
        },
      },
      intervalMs: INTERVAL_MS,
      registry,
      now: () => clock,
    });

    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);

    for (const expected of [2, 3]) {
      clock += INTERVAL_MS;
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      expect(reads).toBe(expected);
    }

    sampler.stop();
    clock += INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(reads).toBe(3);
  });

  it("does not queue a tick behind a sample that is still reading", async () => {
    vi.useFakeTimers();
    const registry = new MetricsRegistry({ cacheMs: 0 });
    let reads = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sampler = createLedgerAuditSampler({
      store: {
        readLedgerAudit: async () => {
          reads += 1;
          await gate;
          return cleanSnapshot();
        },
      },
      intervalMs: INTERVAL_MS,
      registry,
      now: () => T0,
    });

    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);

    // Three intervals elapse while the first read is still waiting. Each tick
    // returns immediately rather than stacking another read.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(reads).toBe(1);

    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);

    // The tick after the pass finished reads again.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(reads).toBe(2);
    sampler.stop();
  });

  it("keeps the age rising and the last good counts after a failed sample", async () => {
    const registry = new MetricsRegistry({ cacheMs: 0 });
    let clock = T0;
    let failing = false;
    const sampler = createLedgerAuditSampler({
      store: {
        readLedgerAudit: async () => {
          if (failing) throw new Error("database is down");
          return cleanSnapshot();
        },
      },
      intervalMs: INTERVAL_MS,
      registry,
      now: () => clock,
    });

    await sampler.sample();
    expect(registry.render()).toContain("sandbox_ledger_audit_age_seconds 0");

    failing = true;
    clock += INTERVAL_MS;
    await sampler.sample();

    const text = registry.render();
    expect(text).toContain("sandbox_ledger_audit_failures_total 1");
    // The last good reading survives: a failure must not read as balance.
    expect(text).toContain('sandbox_ledger_divergence{reason="settled_without_ledger"} 0');
    expect(text).toContain("sandbox_ledger_audit_age_seconds 300");

    // One more interval without a success: the age keeps climbing, which is
    // what the staleness alert keys on.
    clock += INTERVAL_MS;
    sampler.collect();
    expect(registry.render()).toContain("sandbox_ledger_audit_age_seconds 600");
    expect(registry.render()).toContain("sandbox_ledger_audit_failures_total 1");
  });

  it("recovers the age to zero after the next successful sample", async () => {
    const registry = new MetricsRegistry({ cacheMs: 0 });
    let clock = T0;
    let failing = false;
    const sampler = createLedgerAuditSampler({
      store: {
        readLedgerAudit: async () => {
          if (failing) throw new Error("database is down");
          return cleanSnapshot();
        },
      },
      intervalMs: INTERVAL_MS,
      registry,
      now: () => clock,
    });

    await sampler.sample();
    failing = true;
    clock += INTERVAL_MS;
    await sampler.sample();
    expect(registry.render()).toContain("sandbox_ledger_audit_age_seconds 300");

    failing = false;
    clock += INTERVAL_MS;
    await sampler.sample();

    const text = registry.render();
    expect(text).toContain("sandbox_ledger_audit_age_seconds 0");
    expect(text).toContain('sandbox_ledger_divergence{reason="settled_without_ledger"} 0');
  });
});
