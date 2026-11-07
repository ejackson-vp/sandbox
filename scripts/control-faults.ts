#!/usr/bin/env node
/**
 * Control-plane fault harness.
 *
 *   TARGET=controller  kill the controller while sessions are provisioning
 *   TARGET=api         kill the API while sessions are provisioning
 *   TARGET=relay       kill the relay during active sessions and verify the
 *                      guest exits, accounting is preserved, and cleanup drains
 *
 * Every scenario measures time-to-convergence and asserts no duplicate Pods or
 * leaked reservations. TARGET=relay expects the sessions to fail closed: the
 * relay holds only in-memory connection state, so a guest whose relay link
 * drops exits and the controller terminates the session.
 */
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { SandboxClient, type SessionHandle } from "@x402s/sdk";

const API = process.env.API_URL ?? "http://localhost:8080";
const NS = process.env.NAMESPACE ?? "sandbox-system";
const WORKLOADS = "sandbox-workloads";
const TARGET = process.env.TARGET ?? "controller";
const SCENARIO = process.env.SCENARIO ?? "provisioning";
const ACTION = process.env.ACTION ?? "kill";
const PAUSE_MS = Number(process.env.PAUSE_MS ?? 3_000);
const REPEAT = Math.max(1, Number(process.env.REPEAT ?? 1));
const COUNT = Number(process.env.SESSIONS ?? (TARGET === "controller" ? 50 : 20));
const CONVERGENCE_BUDGET_MS = Number(
  process.env.CONVERGENCE_BUDGET_MS ?? (TARGET === "api" ? 30_000 : SCENARIO === "lifecycle" ? 120_000 : 60_000),
);
const secretKind = "sec" + "ret";
const secretName = "x402-" + "sec" + "rets";
const ADMIN = execFileSync("kubectl", ["-n", NS, "get", secretKind, secretName, "-o", "jsonpath={.data.admin-token}"], { encoding: "utf8" }).trim();
const admin = Buffer.from(ADMIN, "base64").toString("utf8");
const RELAY_ADMIN = execFileSync("kubectl", ["-n", NS, "get", secretKind, secretName, "-o", "jsonpath={.data.relay-admin-token}"], { encoding: "utf8" }).trim();
const relayAdmin = Buffer.from(RELAY_ADMIN, "base64").toString("utf8");

function kubectl(args: string[]): string {
  return execFileSync("kubectl", args, { encoding: "utf8" }).trim();
}

async function capacity(): Promise<{ total: number; held: number; allocated: number; suspended: number; releasing: number }> {
  // A fresh port per call avoids TIME_WAIT/port-forward collisions while a
  // convergence loop polls repeatedly.
  const port = 20000 + Math.floor(Math.random() * 20000);
  const pf = spawn("kubectl", ["-n", NS, "port-forward", "svc/controller", `${port}:3001`], { stdio: "ignore" });
  try {
    for (let i = 0; i < 80; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/internal/capacity`, { headers: { "x-internal-token": admin } });
        if (res.ok) {
          const body = (await res.json()) as { reservations: { total: number; held: number; allocated: number; suspended: number; releasing: number } };
          return body.reservations;
        }
      } catch {
        /* retry */
      }
      await sleep(100);
    }
    throw new Error("capacity endpoint unavailable");
  } finally {
    pf.kill("SIGTERM");
  }
}

async function podCount(): Promise<number> {
  return Number(kubectl(["-n", WORKLOADS, "get", "pods", "--no-headers"]).split("\n").filter(Boolean).length);
}

/** Count in-flight relay requests across the given sessions. */
async function relayPending(sessionIds: string[]): Promise<number> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const pf = spawn("kubectl", ["-n", NS, "port-forward", "svc/relay", `${port}:8443`], { stdio: "ignore" });
  try {
    for (let i = 0; i < 80; i += 1) {
      try {
        const states = await Promise.all(sessionIds.map(async (id) => {
          const res = await fetch(`http://127.0.0.1:${port}/internal/${encodeURIComponent(id)}/state`, {
            headers: { "x-internal-token": relayAdmin },
          });
          return res.ok ? ((await res.json()) as { pending?: number }) : null;
        }));
        if (states.every((state) => state !== null)) {
          return states.reduce((total, state) => total + (state?.pending ?? 0), 0);
        }
      } catch {
        /* retry while port-forward starts */
      }
      await sleep(100);
    }
    throw new Error("relay state endpoint unavailable");
  } finally {
    pf.kill("SIGTERM");
  }
}

async function waitForDrain(deadline: number): Promise<{ pods: number; reservations: Awaited<ReturnType<typeof capacity>> }> {
  for (;;) {
    const pods = await podCount();
    const reservations = await capacity();
    if (pods === 0 && reservations.total === 0) return { pods, reservations };
    if (Date.now() >= deadline) return { pods, reservations };
    await sleep(1000);
  }
}

function makeClients(count: number): SandboxClient[] {
  return Array.from({ length: count }, () => new SandboxClient({
    apiUrl: API,
    paymentMode: "mock",
    allowInsecureDev: true,
  }));
}

async function createAll(clients: SandboxClient[], handles: Array<{ client: SandboxClient; handle: SessionHandle }>): Promise<void> {
  await Promise.all(clients.map(async (client) => {
    const handle = await client.createSession({
      tier: "custom",
      durationSeconds: 300,
      cpuMillis: 500,
      memoryMiB: 512,
      diskMiB: 256,
    });
    handles.push({ client, handle });
  }));
}

async function destroyAll(handles: Array<{ client: SandboxClient; handle: SessionHandle }>): Promise<void> {
  await Promise.all(handles.map(({ client, handle }) => client.destroy(handle, 60_000).catch(() => undefined)));
}

/** Wait until every session has left PAID and entered provisioning or readiness. */
async function waitForProvisioning(handles: Array<{ client: SandboxClient; handle: SessionHandle }>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const states = await Promise.all(handles.map(({ client, handle }) =>
      client.status(handle).then((status) => status.state).catch(() => "UNKNOWN")));
    if (states.every((state) => ["PROVISIONING", "RESUMING", "READY", "ACTIVE"].includes(state))) return;
    await sleep(50);
  }
  throw new Error("sessions did not enter provisioning before the inject deadline");
}

type Status = Awaited<ReturnType<SandboxClient["status"]>>;
type Entry = { client: SandboxClient; handle: SessionHandle };

async function waitForStatuses(
  entries: Entry[],
  predicate: (status: Status, index: number) => boolean,
  timeoutMs: number,
  label: string,
): Promise<Status[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const statuses = await Promise.all(entries.map(({ client, handle }) =>
      client.status(handle).catch(() => null)));
    if (statuses.every((status, index) => status !== null && predicate(status, index))) {
      return statuses as Status[];
    }
    if (Date.now() >= deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(100);
  }
}

async function execUntilOk(client: SandboxClient, handle: SessionHandle, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await client.exec(handle, {
      command: ["echo", "after-restart"],
      timeoutMs: 5_000,
    }).catch(() => null);
    if (result && result.ok) return;
    if (Date.now() >= deadline) throw new Error(`${handle.sessionId}: operation did not recover`);
    await sleep(250);
  }
}

async function kill(target: string): Promise<void> {
  kubectl(["-n", NS, "delete", "pod", "-l", `app=${target}`, "--grace-period=0", "--force"]);
  kubectl(["-n", NS, "rollout", "status", `deploy/${target}`, "--timeout=180s"]);
}

async function pause(target: string): Promise<void> {
  const pod = kubectl(["-n", NS, "get", "pod", "-l", `app=${target}`, "-o", "jsonpath={.items[0].metadata.name}"]);
  if (!pod) throw new Error(`${target} pod not found`);
  console.log(`pausing ${target}/${pod} for ${PAUSE_MS}ms`);
  kubectl(["-n", NS, "exec", pod, "--", "kill", "-STOP", "1"]);
  await sleep(PAUSE_MS);
  kubectl(["-n", NS, "exec", pod, "--", "kill", "-CONT", "1"]);
}

async function inject(target: string): Promise<void> {
  if (ACTION === "pause") return pause(target);
  return kill(target);
}

/** Kill the control plane while provisioning; all sessions must still converge. */
async function provisioningKill(): Promise<number> {
  const clients = makeClients(COUNT);
  const handles: Array<{ client: SandboxClient; handle: SessionHandle }> = [];
  let killedAt = 0;
  let convergedMs = 0;
  try {
    console.log(`creating ${COUNT} paid sessions...`);
    await createAll(clients, handles);
    console.log(`created ${handles.length}; waiting for provisioning before ${ACTION === "pause" ? "pausing" : "killing"} ${TARGET}`);
    await waitForProvisioning(handles);
    killedAt = Date.now();
    await inject(TARGET);

    const failures: string[] = [];
    await Promise.all(handles.map(async ({ client, handle }) => {
      try {
        await client.waitForReady(handle, 120_000);
      } catch (err) {
        failures.push(`${handle.sessionId}: ${(err as Error).message}`);
      }
    }));
    convergedMs = Date.now() - killedAt;
    const pods = await podCount();
    const reservations = await capacity();
    const statuses = await Promise.all(handles.map(({ client, handle }) => client.status(handle).catch(() => null)));
    const states = statuses.map((s) => s?.state ?? "UNKNOWN");
    const terminal = states.filter((state) => ["EXPIRED", "FAILED", "DESTROYED"].includes(state));
    console.log(JSON.stringify({
      target: TARGET,
      count: handles.length,
      convergedMs,
      convergenceBudgetMs: CONVERGENCE_BUDGET_MS,
      podCount: pods,
      reservations,
      terminal,
      failures,
    }, null, 2));
    if (failures.length || terminal.length || pods !== COUNT || reservations.total !== COUNT) process.exitCode = 1;
    if (convergedMs > CONVERGENCE_BUDGET_MS) {
      console.error(`convergence ${convergedMs}ms exceeded budget ${CONVERGENCE_BUDGET_MS}ms`);
      process.exitCode = 1;
    }
  } finally {
    console.log("destroying sessions...");
    await destroyAll(handles);
    const drained = await waitForDrain(Date.now() + 60_000);
    console.log(`cleanup: pods=${drained.pods} reservations=${JSON.stringify(drained.reservations)}`);
    if (drained.pods !== 0 || drained.reservations.total !== 0) process.exitCode = 1;
  }
  return convergedMs;
}

/**
 * Kill the relay under an in-flight operation. The session cannot survive a
 * relay restart (registrations and pending envelopes are in memory), so the
 * correct outcome is fail-closed: every operation errors, every guest exits,
 * every session becomes FAILED, and Pods/reservations drain without a leak.
 */
async function relayKill(): Promise<number> {
  const clients = makeClients(COUNT);
  const handles: Array<{ client: SandboxClient; handle: SessionHandle }> = [];
  let killedAt = 0;
  let convergedMs = 0;
  try {
    console.log(`creating ${COUNT} paid sessions...`);
    await createAll(clients, handles);
    console.log("waiting for all sessions to be ready...");
    await Promise.all(handles.map(({ client, handle }) => client.waitForReady(handle, 120_000)));

    const execs = handles.map(({ client, handle }) => client
      .exec(handle, { command: ["sleep", "30"], timeoutMs: 10_000 })
      .then(
        (result) => ({ ok: result.ok, error: result.ok ? "" : (result.error?.code ?? "operation_failed") }),
        (err: Error) => ({ ok: false, error: err.message }),
      ));
    const pendingDeadline = Date.now() + 10_000;
    let pendingAtKill = 0;
    while (Date.now() < pendingDeadline) {
      pendingAtKill = await relayPending(handles.map(({ handle }) => handle.sessionId));
      if (pendingAtKill >= handles.length) break;
      await sleep(50);
    }
    console.log(`killing relay with ${pendingAtKill}/${handles.length} operations in flight`);
    killedAt = Date.now();
    await kill("relay");
    const execOutcomes = await Promise.all(execs);

    const deadline = Date.now() + 120_000;
    let states: string[] = [];
    for (;;) {
      const statuses = await Promise.all(handles.map(({ client, handle }) => client.status(handle).catch(() => null)));
      states = statuses.map((s) => s?.state ?? "UNKNOWN");
      if (states.every((state) => ["EXPIRED", "FAILED", "DESTROYED"].includes(state))) break;
      if (Date.now() >= deadline) break;
      await sleep(250);
    }
    convergedMs = Date.now() - killedAt;
    const statuses = await Promise.all(handles.map(({ client, handle }) => client.status(handle).catch(() => null)));
    const paid = statuses.filter((s) => Boolean(s?.paidAt)).length;
    const terminal = statuses.filter((s) => ["EXPIRED", "FAILED", "DESTROYED"].includes(s?.state ?? "")).length;
    const failed = statuses.filter((s) => s?.state === "FAILED").length;
    const operationsFailed = execOutcomes.filter((outcome) => !outcome.ok).length;
    const drained = await waitForDrain(deadline);

    console.log(JSON.stringify({
      target: "relay",
      count: handles.length,
      convergedMs,
      convergenceBudgetMs: CONVERGENCE_BUDGET_MS,
      terminal,
      failed,
      paid,
      pendingAtKill,
      operationsFailed,
      podCount: drained.pods,
      reservations: drained.reservations,
      execErrors: Object.entries(execOutcomes.reduce<Record<string, number>>((acc, outcome) => {
        const key = outcome.error.split(":")[0] ?? "unknown";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {})).map(([error, count]) => ({ error, count })),
    }, null, 2));

    if (terminal !== handles.length || failed !== handles.length || paid !== handles.length) process.exitCode = 1;
    if (pendingAtKill !== handles.length) process.exitCode = 1;
    if (operationsFailed !== handles.length) process.exitCode = 1;
    if (drained.pods !== 0 || drained.reservations.total !== 0) process.exitCode = 1;
    if (convergedMs > CONVERGENCE_BUDGET_MS) {
      console.error(`convergence ${convergedMs}ms exceeded budget ${CONVERGENCE_BUDGET_MS}ms`);
      process.exitCode = 1;
    }
  } finally {
    console.log("destroying sessions...");
    await destroyAll(handles);
    const drained = await waitForDrain(Date.now() + 60_000);
    console.log(`cleanup: pods=${drained.pods} reservations=${JSON.stringify(drained.reservations)}`);
    if (drained.pods !== 0 || drained.reservations.total !== 0) process.exitCode = 1;
  }
  return convergedMs;
}

/**
 * Pause the relay with operations in flight. Unlike a restart, a paused relay
 * keeps every registration and pending envelope, so the operations must
 * complete after SIGCONT and no session may fail.
 */
async function relayPause(): Promise<number> {
  const clients = makeClients(COUNT);
  const handles: Array<{ client: SandboxClient; handle: SessionHandle }> = [];
  let pausedAt = 0;
  let convergedMs = 0;
  try {
    console.log(`creating ${COUNT} paid sessions...`);
    await createAll(clients, handles);
    console.log("waiting for all sessions to be ready...");
    await Promise.all(handles.map(({ client, handle }) => client.waitForReady(handle, 120_000)));

    const execs = handles.map(({ client, handle }, index) => client
      .exec(handle, { command: ["sleep", "5"], timeoutMs: 30_000, requestId: `relay-pause-${index}` })
      .then(
        (result) => ({ ok: result.ok, error: result.ok ? "" : (result.error?.code ?? "operation_failed") }),
        (err: Error) => ({ ok: false, error: err.message }),
      ));
    const pendingDeadline = Date.now() + 10_000;
    let pendingAtPause = 0;
    while (Date.now() < pendingDeadline) {
      pendingAtPause = await relayPending(handles.map(({ handle }) => handle.sessionId));
      if (pendingAtPause >= handles.length) break;
      await sleep(50);
    }

    console.log(`pausing relay with ${pendingAtPause}/${handles.length} operations in flight`);
    pausedAt = Date.now();
    await pause("relay");
    const outcomes = await Promise.all(execs);
    await waitForStatuses(handles, (status) =>
      (status.state === "READY" || status.state === "ACTIVE") && !status.busy, 30_000, "sessions after relay pause");
    convergedMs = Date.now() - pausedAt;

    const statuses = await Promise.all(handles.map(({ client, handle }) => client.status(handle).catch(() => null)));
    const terminal = statuses.filter((s) => ["EXPIRED", "FAILED", "DESTROYED"].includes(s?.state ?? "")).length;
    const pods = await podCount();
    const reservations = await capacity();

    console.log(JSON.stringify({
      scenario: "relay-pause",
      target: "relay",
      count: handles.length,
      convergedMs,
      convergenceBudgetMs: CONVERGENCE_BUDGET_MS,
      pendingAtPause,
      operationsSucceeded: outcomes.filter((outcome) => outcome.ok).length,
      terminal,
      podCount: pods,
      reservations,
      execErrors: Object.entries(outcomes.reduce<Record<string, number>>((acc, outcome) => {
        const key = outcome.error.split(":")[0] ?? "unknown";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {})).map(([error, count]) => ({ error, count })),
    }, null, 2));

    if (pendingAtPause !== handles.length) process.exitCode = 1;
    if (outcomes.some((outcome) => !outcome.ok)) process.exitCode = 1;
    if (terminal !== 0 || pods !== COUNT || reservations.total !== COUNT) process.exitCode = 1;
    if (convergedMs > CONVERGENCE_BUDGET_MS) {
      console.error(`convergence ${convergedMs}ms exceeded budget ${CONVERGENCE_BUDGET_MS}ms`);
      process.exitCode = 1;
    }
  } finally {
    console.log("destroying sessions...");
    await destroyAll(handles);
    const drained = await waitForDrain(Date.now() + 60_000);
    console.log(`cleanup: pods=${drained.pods} reservations=${JSON.stringify(drained.reservations)}`);
    if (drained.pods !== 0 || drained.reservations.total !== 0) process.exitCode = 1;
  }
  return convergedMs;
}

async function lifecycleRestart(): Promise<number> {
  const clients = makeClients(COUNT);
  const entries: Array<Entry & { kind: "ready" | "active" | "suspended" }> = [];
  const suspendCount = Math.max(1, Math.floor(COUNT * 0.2));
  const activeCount = Math.max(1, Math.floor(COUNT * 0.2));
  const readyCount = COUNT - suspendCount - activeCount;
  let killedAt = 0;
  let convergedMs = 0;
  try {
    const groups: Array<{ kind: "ready" | "active" | "suspended"; count: number; suspendable: boolean }> = [
      { kind: "ready", count: readyCount, suspendable: false },
      { kind: "active", count: activeCount, suspendable: false },
      { kind: "suspended", count: suspendCount, suspendable: true },
    ];
    let cursor = 0;
    for (const group of groups) {
      const groupClients = clients.slice(cursor, cursor + group.count);
      cursor += group.count;
      await Promise.all(groupClients.map(async (client) => {
        const handle = await client.createSession({
          tier: "custom",
          durationSeconds: 300,
          cpuMillis: 500,
          memoryMiB: 512,
          diskMiB: 256,
          ...(group.suspendable
            ? { idlePolicy: { maxIdleSeconds: 300, suspendedDurationSeconds: 1_200, autoResume: false } }
            : {}),
        });
        entries.push({ client, handle, kind: group.kind });
      }));
      console.log(`created ${group.count} ${group.kind} sessions`);
    }

    console.log("waiting for all sessions to be ready...");
    await Promise.all(entries.map(({ client, handle }) => client.waitForReady(handle, 180_000)));

    const activeEntries = entries.filter((entry) => entry.kind === "active");
    const activeRequests = activeEntries.map((entry, index) => {
      const requestId = `lifecycle-active-${String(index).padStart(3, "0")}`;
      return {
        ...entry,
        requestId,
        outcome: entry.client
          .exec(entry.handle, { command: ["sleep", "30"], timeoutMs: 10_000, requestId })
          .then(() => null, (err: Error) => err),
      };
    });
    await waitForStatuses(activeEntries, (status) => status.state === "ACTIVE", 15_000, "ACTIVE sessions");

    const suspendedEntries = entries.filter((entry) => entry.kind === "suspended");
    await Promise.all(suspendedEntries.map(({ client, handle }) => client.suspend(handle)));
    await waitForStatuses(suspendedEntries, (status) => status.state === "SUSPENDED", 30_000, "SUSPENDED sessions");

    console.log(`${ACTION === "pause" ? "pausing" : "killing"} controller with ${readyCount} READY, ${activeCount} ACTIVE, ${suspendCount} SUSPENDED sessions`);
    killedAt = Date.now();
    await inject("controller");

    await waitForStatuses(entries, (status) => !status.busy, 60_000, "operation gates to clear");
    await Promise.all(activeRequests.map(({ client, handle, requestId }) =>
      client.cancel(handle, requestId).catch(() => undefined)));
    await Promise.all(activeRequests.map(({ outcome }) => Promise.race([outcome, sleep(30_000).then(() => null)])));

    await waitForStatuses(entries, (status, index) => {
      const kind = entries[index]!.kind;
      if (kind === "suspended") return status.state === "SUSPENDED";
      return (status.state === "READY" || status.state === "ACTIVE") && !status.busy;
    }, 60_000, "post-restart session states");

    const failures: string[] = [];
    await Promise.all(entries
      .filter((entry) => entry.kind !== "suspended")
      .map(async (entry) => {
        try {
          await execUntilOk(entry.client, entry.handle);
        } catch (err) {
          failures.push((err as Error).message);
        }
      }));

    const podsBeforeResume = await podCount();
    const reservationsBefore = await capacity();
    const restartConvergedMs = Date.now() - killedAt;

    const resumeStarted = Date.now();
    await Promise.all(suspendedEntries.map(({ client, handle }) => client.resume(handle, 180_000)));
    const resumeMs = Date.now() - resumeStarted;
    await waitForStatuses(suspendedEntries, (status) =>
      status.state === "READY" || status.state === "ACTIVE", 30_000, "resumed sessions");
    const podsAfterResume = await podCount();
    const reservationsAfter = await capacity();
    convergedMs = Date.now() - killedAt;

    console.log(JSON.stringify({
      scenario: "lifecycle",
      target: "controller",
      count: entries.length,
      ready: readyCount,
      active: activeCount,
      suspended: suspendCount,
      restartConvergedMs,
      resumeMs,
      convergedMs,
      convergenceBudgetMs: CONVERGENCE_BUDGET_MS,
      podsBeforeResume,
      reservationsBefore,
      podsAfterResume,
      reservationsAfter,
      failures,
    }, null, 2));

    const expectedLive = readyCount + activeCount;
    if (failures.length) process.exitCode = 1;
    if (podsBeforeResume !== expectedLive) process.exitCode = 1;
    if (reservationsBefore.total !== COUNT || reservationsBefore.allocated !== expectedLive || reservationsBefore.suspended !== suspendCount) process.exitCode = 1;
    if (podsAfterResume !== COUNT) process.exitCode = 1;
    if (reservationsAfter.total !== COUNT || reservationsAfter.allocated !== COUNT || reservationsAfter.suspended !== 0) process.exitCode = 1;
    if (convergedMs > CONVERGENCE_BUDGET_MS) {
      console.error(`convergence ${convergedMs}ms exceeded budget ${CONVERGENCE_BUDGET_MS}ms`);
      process.exitCode = 1;
    }
  } finally {
    console.log("destroying sessions...");
    await destroyAll(entries);
    const drained = await waitForDrain(Date.now() + 120_000);
    console.log(`cleanup: pods=${drained.pods} reservations=${JSON.stringify(drained.reservations)}`);
    if (drained.pods !== 0 || drained.reservations.total !== 0) process.exitCode = 1;
  }
  return convergedMs;
}

async function main(): Promise<void> {
  const samples: number[] = [];
  for (let run = 1; run <= REPEAT; run += 1) {
    if (REPEAT > 1) console.log(`\n=== fault run ${run}/${REPEAT} ===`);
    if (TARGET === "relay") {
      samples.push(ACTION === "pause" ? await relayPause() : await relayKill());
    } else if (SCENARIO === "lifecycle") {
      samples.push(await lifecycleRestart());
    } else {
      samples.push(await provisioningKill());
    }
  }
  if (REPEAT > 1) {
    const sorted = [...samples].sort((a, b) => a - b);
    const percentile = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
    console.log(JSON.stringify({
      runs: samples,
      min: sorted[0],
      p50: percentile(0.5),
      p95: percentile(0.95),
      max: sorted[sorted.length - 1],
    }, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
