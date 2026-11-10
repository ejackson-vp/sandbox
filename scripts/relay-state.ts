/**
 * Relay pending-frame reader for the cluster fault harness.
 *
 * After #91/#93 a cluster relay mounts `/internal/*` only on the mTLS control
 * listener (8444); the plaintext 8443 listener is guest-only. The harness needs
 * the cluster-wide number of frames awaiting a guest response, not per-session
 * state, so it reads the scrape-time Prometheus gauge
 * `sandbox_relay_pending_requests` from the relay's private `:9100/metrics`
 * listener. That listener is unauthenticated by design (Prometheus scrapes it)
 * and never carries a control route; the operator reaches it with a
 * `kubectl port-forward`, which is what this helper does.
 *
 * Kept separate from control-faults.ts to stay inside the module size limit and
 * to make the polling loop testable without a cluster.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/** The gauge `RelayRegistry` refreshes at scrape time. */
export const RELAY_PENDING_GAUGE = "sandbox_relay_pending_requests";

export interface RelayPendingOptions {
  namespace: string;
  /** Return as soon as the total equals this. */
  until?: number;
  /** How long to keep polling after the port-forward is established. */
  waitMs?: number;
}

/**
 * Extract one label-less gauge from Prometheus text exposition. Returns null
 * when the metric is absent or its sample is not a finite number, so the caller
 * can retry instead of reporting a misleading zero.
 */
export function parsePendingGauge(body: string): number | null {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Za-z_:][A-Za-z0-9_:]*)\s+(-?[0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?)$/.exec(line);
    if (!match) continue;
    if (match[1] !== RELAY_PENDING_GAUGE) continue;
    const value = Number(match[2]);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

/** One scrape of a metrics listener. Null means "not available yet". */
export async function readRelayPending(baseUrl: string): Promise<number | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/metrics`);
    if (!res.ok) return null;
    return parsePendingGauge(await res.text());
  } catch {
    return null;
  }
}

/**
 * Port-forward the relay metrics port and poll the pending gauge. With `until`,
 * poll until the total matches or `waitMs` elapses after the forward is up.
 * Fails explicitly if the gauge never appears, so a topology regression is not
 * mistaken for "zero pending".
 */
export async function relayPending(opts: RelayPendingOptions): Promise<number> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const deadline = Date.now() + (opts.waitMs ?? 0);
  const pf = spawn("kubectl", ["-n", opts.namespace, "port-forward", "svc/relay", `${port}:9100`], {
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  let last: number | undefined;
  try {
    for (let i = 0; i < 80 || Date.now() < deadline; i += 1) {
      const value = await readRelayPending(base);
      if (value !== null) {
        last = value;
        if (opts.until === undefined || value === opts.until) return value;
      }
      await sleep(100);
    }
    if (last !== undefined) return last;
    throw new Error(`relay metrics never exposed ${RELAY_PENDING_GAUGE}`);
  } finally {
    pf.kill("SIGTERM");
  }
}
