/**
 * Fault case: restart the relay while paid creates are starting (#17).
 *
 * `createAll` returns at PAID, so the restart overlaps provisioning rather than
 * a live session. The replacement relay starts with an empty in-memory
 * registry; every create must re-register against it and reach READY. A create
 * may not end terminal, and no session may end `pod_terminated`.
 *
 * Lives beside the harness so `scripts/control-faults.ts` stays reviewable; the
 * harness passes its own scenario helpers in.
 */
import type { SandboxClient, SessionHandle } from "@x402s/sdk";

export type Entry = { client: SandboxClient; handle: SessionHandle };

interface Capacity {
  total: number;
}

export interface RelayCreateRestartDeps {
  count: number;
  budgetMs: number;
  clients: SandboxClient[];
  createAll(clients: SandboxClient[], handles: Entry[]): Promise<void>;
  destroyAll(handles: Entry[]): Promise<void>;
  podCount(): Promise<number>;
  capacity(): Promise<Capacity>;
  waitForDrain(deadline: number): Promise<{ pods: number; reservations: Capacity }>;
  kill(target: string): Promise<void>;
  log(message: string): void;
}

export async function relayCreateRestart(deps: RelayCreateRestartDeps): Promise<number> {
  const handles: Entry[] = [];
  let killedAt = 0;
  let convergedMs = 0;
  try {
    deps.log(`creating ${deps.count} paid sessions...`);
    await deps.createAll(deps.clients, handles);
    killedAt = Date.now();
    deps.log("restarting the relay during provisioning...");
    await deps.kill("relay");

    const failures: string[] = [];
    await Promise.all(handles.map(async ({ client, handle }) => {
      try {
        await client.waitForReady(handle, 120_000);
      } catch (err) {
        failures.push(`${handle.sessionId}: ${(err as Error).message}`);
      }
    }));
    convergedMs = Date.now() - killedAt;

    const statuses = await Promise.all(
      handles.map(({ client, handle }) => client.status(handle).catch(() => null)),
    );
    const ready = statuses.filter((s) => s?.state === "READY" || s?.state === "ACTIVE").length;
    const paid = statuses.filter((s) => Boolean(s?.paidAt)).length;
    const terminal = statuses.filter((s) =>
      ["EXPIRED", "FAILED", "DESTROYED"].includes(s?.state ?? "")).length;
    const podTerminated = statuses.filter((s) => s?.failure?.code === "pod_terminated").length;
    const pods = await deps.podCount();
    const reservations = await deps.capacity();

    console.log(JSON.stringify({
      scenario: "relay-create-restart",
      target: "relay",
      count: handles.length,
      convergedMs,
      convergenceBudgetMs: deps.budgetMs,
      ready,
      paid,
      terminal,
      podTerminated,
      podCount: pods,
      reservations,
      failures,
    }, null, 2));

    if (failures.length || ready !== handles.length) process.exitCode = 1;
    if (terminal !== 0) process.exitCode = 1;
    if (podTerminated !== 0) process.exitCode = 1;
    if (pods !== deps.count || reservations.total !== deps.count) process.exitCode = 1;
    if (convergedMs > deps.budgetMs) {
      console.error(`convergence ${convergedMs}ms exceeded budget ${deps.budgetMs}ms`);
      process.exitCode = 1;
    }
  } finally {
    deps.log("destroying sessions...");
    await deps.destroyAll(handles);
    const drained = await deps.waitForDrain(Date.now() + 60_000);
    deps.log(`cleanup: pods=${drained.pods} reservations=${JSON.stringify(drained.reservations)}`);
    if (drained.pods !== 0 || drained.reservations.total !== 0) process.exitCode = 1;
  }
  return convergedMs;
}
