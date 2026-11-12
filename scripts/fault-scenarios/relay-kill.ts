/**
 * Fault case: kill the relay under an in-flight operation.
 *
 * The registry and pending envelopes are in memory, so the restart drops every
 * guest link on the shard. The session must survive it (ADR 0011): the
 * interrupted operation becomes `outcome_unknown` and is never re-executed, the
 * guest reconnects to the replacement relay, the lease is unchanged, a new
 * operation succeeds, and no session may become terminal. Pods and reservations
 * stay allocated, so the convergence check also proves nothing was torn down and
 * rebuilt.
 *
 * Lives beside the harness so `scripts/control-faults.ts` stays reviewable; the
 * harness passes its own scenario helpers in.
 */
import type { SandboxClient, SessionHandle } from "@x402s/sdk";

type Entry = { client: SandboxClient; handle: SessionHandle };
type Status = Awaited<ReturnType<SandboxClient["status"]>>;

interface Capacity {
  total: number;
  allocated: number;
}

interface RelayKillDeps {
  count: number;
  budgetMs: number;
  clients: SandboxClient[];
  createAll(clients: SandboxClient[], handles: Entry[]): Promise<void>;
  destroyAll(handles: Entry[]): Promise<void>;
  waitForStatuses(
    entries: Entry[],
    predicate: (status: Status) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<Status[]>;
  relayPending(until: number, waitMs: number): Promise<number>;
  podCount(): Promise<number>;
  capacity(): Promise<Capacity>;
  waitForDrain(deadline: number): Promise<{ pods: number; reservations: Capacity }>;
  kill(target: string): Promise<void>;
  log(message: string): void;
}

export async function relayKill(deps: RelayKillDeps): Promise<number> {
  const handles: Entry[] = [];
  let killedAt = 0;
  let convergedMs = 0;
  try {
    deps.log(`creating ${deps.count} paid sessions...`);
    await deps.createAll(deps.clients, handles);
    deps.log("waiting for all sessions to be ready...");
    await Promise.all(handles.map(({ client, handle }) => client.waitForReady(handle, 120_000)));
    const leases = await Promise.all(handles.map(({ client, handle }) =>
      client.status(handle).then((status) => status.leaseExpiresAt ?? "").catch(() => "")));

    const execs = handles.map(({ client, handle }, index) => client
      .exec(handle, { command: ["sleep", "300"], timeoutMs: 300_000, requestId: `relay-kill-${index}` })
      .then(
        (result) => ({ ok: result.ok, error: result.ok ? "" : (result.error?.code ?? "operation_failed") }),
        (err: Error) => ({ ok: false, error: err.message }),
      ));
    const pendingDeadline = Date.now() + 10_000;
    let pendingAtKill = 0;
    while (Date.now() < pendingDeadline) {
      pendingAtKill = await deps.relayPending(handles.length, 10_000);
      if (pendingAtKill >= handles.length) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    deps.log(`killing relay with ${pendingAtKill}/${handles.length} operations in flight`);
    killedAt = Date.now();
    await deps.kill("relay");
    const execOutcomes = await Promise.all(execs);

    // Every interrupted operation is a defined outcome (409 outcome_unknown) or
    // a transport error the SDK surfaced: never a success, never re-executed.
    const operationsUnresolved = execOutcomes.filter((outcome) => !outcome.ok).length;
    const unknown = execOutcomes.filter((outcome) => outcome.error.includes("outcome_unknown")).length;

    // The guest reconnects and the fence clears: READY with the gate open.
    await deps.waitForStatuses(
      handles,
      (status) => status.state === "READY" && !status.busy,
      90_000,
      "sessions after relay restart",
    );
    convergedMs = Date.now() - killedAt;

    const statuses = await Promise.all(handles.map(({ client, handle }) =>
      client.status(handle).catch(() => null)));
    const terminal = statuses.filter((s) =>
      ["EXPIRED", "FAILED", "DESTROYED"].includes(s?.state ?? "")).length;
    const survived = statuses.filter((s) => s?.state === "READY" || s?.state === "ACTIVE").length;
    const after = await Promise.all(handles.map(({ client, handle }) =>
      client.status(handle).then((status) => status.leaseExpiresAt ?? "").catch(() => "")));
    const leasesUnchanged = after.every((lease, index) => lease === leases[index]);

    // A new operation runs after the reconnect, on the bumped execution epoch.
    const newExecs = await Promise.all(handles.map(({ client, handle }, index) => client
      .exec(handle, {
        command: ["echo", `relay-kill-after-${index}`],
        timeoutMs: 30_000,
        requestId: `relay-kill-after-${index}`,
      })
      .then((result) => result.ok, () => false)));
    const newExecSucceeded = newExecs.filter(Boolean).length;

    const pods = await deps.podCount();
    const reservations = await deps.capacity();

    console.log(JSON.stringify({
      target: "relay",
      count: handles.length,
      convergedMs,
      convergenceBudgetMs: deps.budgetMs,
      pendingAtKill,
      terminal,
      survived,
      leasesUnchanged,
      operationsUnresolved,
      operationsOutcomeUnknown: unknown,
      newExecSucceeded,
      podCount: pods,
      reservations,
      execErrors: Object.entries(execOutcomes.reduce<Record<string, number>>((acc, outcome) => {
        const key = outcome.error.split(":")[0] ?? "unknown";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {})).map(([error, count]) => ({ error, count })),
    }, null, 2));

    if (pendingAtKill !== handles.length) process.exitCode = 1;
    if (terminal !== 0) process.exitCode = 1;
    if (survived !== handles.length) process.exitCode = 1;
    if (!leasesUnchanged) process.exitCode = 1;
    if (operationsUnresolved !== handles.length) process.exitCode = 1;
    if (unknown === 0) process.exitCode = 1;
    if (newExecSucceeded !== handles.length) process.exitCode = 1;
    if (pods !== deps.count || reservations.allocated !== deps.count) process.exitCode = 1;
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
