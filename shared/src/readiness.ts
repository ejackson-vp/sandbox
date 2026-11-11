/**
 * Cached readiness checks shared by the API and controller.
 *
 * Liveness answers "is the event loop turning?" and must not touch
 * dependencies. Readiness answers "can this process serve traffic right now?"
 * and is allowed to be briefly stale: Kubernetes probes run every few seconds,
 * so a short positive and negative cache keeps a dependency outage from turning
 * into a probe storm against the store, relay or Kubernetes API.
 *
 * The report shape itself is wire contract, so it lives in `protocol/control.ts`
 * with the rest of the API <-> controller surface. This module owns the cache
 * and the probes.
 */
import type { ComponentHealth, ReadinessReport } from "./protocol/control.js";

export type ComponentCheck = () => Promise<ComponentHealth> | ComponentHealth;

const DEFAULT_TTL_MS = 2_000;

export class ReadinessCache {
  private cached: { at: number; report: Omit<ReadinessReport, "cached"> } | null = null;
  private inflight: Promise<ReadinessReport> | null = null;

  constructor(
    private readonly checks: Record<string, ComponentCheck>,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  async check(): Promise<ReadinessReport> {
    const now = Date.now();
    if (this.cached && now - this.cached.at <= this.ttlMs) {
      return { ...this.cached.report, cached: true };
    }
    // Concurrent kubelet probes (or tests) share one dependency pass.
    if (!this.inflight) {
      this.inflight = this.probe().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /**
   * Drop the cached pass, so the next probe sees the change immediately.
   *
   * Used when leadership moves: a stale positive report would keep a standby in
   * the Service for up to the TTL after it stopped being the writer, and a stale
   * negative one would keep the new leader out.
   */
  invalidate(): void {
    this.cached = null;
  }

  private async probe(): Promise<ReadinessReport> {
    const names = Object.keys(this.checks);
    const results = await Promise.all(
      names.map(async (name): Promise<[string, ComponentHealth]> => {
        const check = this.checks[name];
        if (!check) return [name, { ok: false, reason: "unavailable" }];
        try {
          return [name, await check()];
        } catch {
          // A check that throws without classifying itself is still bounded.
          return [name, { ok: false, reason: "unavailable" }];
        }
      }),
    );
    const components = Object.fromEntries(results);
    const report = {
      ok: results.every(([, health]) => health.ok),
      checkedAt: Date.now(),
      components,
    };
    this.cached = { at: report.checkedAt, report };
    return { ...report, cached: false };
  }
}
