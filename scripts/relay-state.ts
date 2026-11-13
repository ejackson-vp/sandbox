/**
 * Relay gauge readers for the cluster fault harness.
 *
 * After #91/#93 a cluster relay mounts `/internal/*` only on the mTLS control
 * listener (8444); the plaintext 8443 listener is guest-only. The harness needs
 * cluster-wide state, not per-session control access, so it reads scrape-time
 * Prometheus gauges from the relay's private `:9100/metrics` listener. That
 * listener is unauthenticated by design (Prometheus scrapes it) and never
 * carries a control route; the operator reaches it with a `kubectl
 * port-forward`, which is what this helper does.
 *
 * Kept separate from control-faults.ts to stay inside the module size limit and
 * to make the polling loop testable without a cluster.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/** Frames awaiting a guest response. */
export const RELAY_PENDING_GAUGE = "sandbox_relay_pending_requests";
/** Operations the guests themselves report as running. */
export const RELAY_ACTIVE_GAUGE = "sandbox_relay_active_requests";
/** Registrations that currently have a live guest socket. */
export const RELAY_CONNECTED_GAUGE = "sandbox_relay_connected_sessions";

interface RelayGaugeOptions {
  namespace: string;
  /** Return as soon as the value equals this. */
  until?: number;
  /** How long to keep polling after the port-forward is established. */
  waitMs?: number;
}

/**
 * Extract one label-less gauge from Prometheus text exposition. Returns null
 * when the metric is absent or its sample is not a finite number, so the caller
 * can retry instead of reporting a misleading zero.
 */
function parseGauge(body: string, name: string): number | null {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Za-z_:][A-Za-z0-9_:]*)\s+(-?[0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?)$/.exec(line);
    if (!match) continue;
    if (match[1] !== name) continue;
    const value = Number(match[2]);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

export function parsePendingGauge(body: string): number | null {
  return parseGauge(body, RELAY_PENDING_GAUGE);
}

export function parseActiveGauge(body: string): number | null {
  return parseGauge(body, RELAY_ACTIVE_GAUGE);
}

export function parseConnectedGauge(body: string): number | null {
  return parseGauge(body, RELAY_CONNECTED_GAUGE);
}

/** One scrape of a metrics listener. Null means "not available yet". */
async function readRelayGauge(baseUrl: string, name: string): Promise<number | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/metrics`);
    if (!res.ok) return null;
    return parseGauge(await res.text(), name);
  } catch {
    return null;
  }
}

export async function readRelayPending(baseUrl: string): Promise<number | null> {
  return readRelayGauge(baseUrl, RELAY_PENDING_GAUGE);
}

export async function readRelayActive(baseUrl: string): Promise<number | null> {
  return readRelayGauge(baseUrl, RELAY_ACTIVE_GAUGE);
}

export async function readRelayConnected(baseUrl: string): Promise<number | null> {
  return readRelayGauge(baseUrl, RELAY_CONNECTED_GAUGE);
}

/**
 * Port-forward the relay metrics port and poll one gauge. With `until`, poll
 * until the value matches or `waitMs` elapses after the forward is up. Fails
 * explicitly if the gauge never appears, so a topology regression is not
 * mistaken for a real zero.
 */
async function relayGauge(name: string, opts: RelayGaugeOptions): Promise<number> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const deadline = Date.now() + (opts.waitMs ?? 0);
  const pf = spawn("kubectl", ["-n", opts.namespace, "port-forward", "svc/relay", `${port}:9100`], {
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  let last: number | undefined;
  try {
    for (let i = 0; i < 80 || Date.now() < deadline; i += 1) {
      const value = await readRelayGauge(base, name);
      if (value !== null) {
        last = value;
        if (opts.until === undefined || value === opts.until) return value;
      }
      await sleep(100);
    }
    if (last !== undefined) return last;
    throw new Error(`relay metrics never exposed ${name}`);
  } finally {
    pf.kill("SIGTERM");
  }
}

export function relayPending(opts: RelayGaugeOptions): Promise<number> {
  return relayGauge(RELAY_PENDING_GAUGE, opts);
}

export function relayActive(opts: RelayGaugeOptions): Promise<number> {
  return relayGauge(RELAY_ACTIVE_GAUGE, opts);
}

/**
 * Registrations that currently have a live guest socket, optionally polled
 * until the value reaches `until`.
 *
 * `READY && !busy` is not enough after a relay restart: the session row can be
 * READY while the registry has no registration, and a new operation then fails
 * with `guest_not_available`. This is the signal the fault harness waits on
 * before it treats a new operation as the post-reconnect proof.
 */
export function relayConnected(opts: RelayGaugeOptions): Promise<number> {
  return relayGauge(RELAY_CONNECTED_GAUGE, opts);
}
