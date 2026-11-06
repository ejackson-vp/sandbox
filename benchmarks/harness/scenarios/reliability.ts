import type { BenchOptions } from "../lib/options.js";
import { Bench, createAndReady, timedDestroy, timedExec, type SampleRow } from "../lib/runner.js";
import { kubectl, kubectlTry, sandboxPodCount, waitForPodGone, waitForNoSandboxPods } from "../lib/env.js";
import { fmtMs, mapLimit, sleep, summarize } from "../lib/util.js";

function spec(opts: BenchOptions, durationSeconds: number) {
  return {
    tier: "custom" as const,
    durationSeconds,
    cpuMillis: opts.cpuMillis,
    memoryMiB: opts.memoryMiB,
    diskMiB: opts.diskMiB,
  };
}

/** Wait until at least one pod of the deployment is Running and ready. */
async function waitDeployment(name: string, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = kubectlTry([
      "-n",
      "sandbox-system",
      "get",
      "pods",
      "-l",
      `app=${name}`,
      "-o",
      'jsonpath={range .items[*]}{.status.phase}{"\t"}{.status.containerStatuses[0].ready}{"\n"}{end}',
    ]);
    if (res.ok) {
      const ready = res.out
        .split("\n")
        .filter(Boolean)
        .some((line) => line.startsWith("Running") && line.trim().endsWith("true"));
      if (ready) return true;
    }
    await sleep(250);
  }
  return false;
}

function deletePods(label: string): void {
  kubectlTry(["-n", "sandbox-system", "delete", "pod", "-l", label, "--grace-period=0", "--force"]);
}

function record(bench: Bench, out: Record<string, unknown>, row: SampleRow): void {
  bench.append(row);
  out[row.scenario] = row;
  bench.note(`${row.scenario}: ok=${row.ok} ${row.errorCode ?? ""} ${row.notes ?? ""}`);
}

export async function runReliability(bench: Bench, opts: BenchOptions): Promise<number> {
  const out: Record<string, unknown> = {};

  // 1. Concurrent session creation.
  {
    const t0 = performance.now();
    const results = await mapLimit(Array.from({ length: 20 }, (_, i) => i), 20, async () => {
      try {
        const h = await bench.client.createSession(spec(opts, 120));
        return { h };
      } catch (err) {
        return { error: (err as { code?: string }).code ?? "create_failed" };
      }
    });
    const created = results.filter((r) => "h" in r && r.h).map((r) => (r as { h: any }).h);
    const errors = results.filter((r) => "error" in r).map((r) => (r as { error: string }).error);
    const latencies: number[] = [];
    for (const h of created) {
      try {
        await bench.client.waitForReady(h, 120_000);
        latencies.push(performance.now() - t0);
      } catch {
        errors.push("not_ready");
      }
    }
    for (const h of created) await bench.client.destroy(h, 60_000).catch(() => null);
    record(bench, out, {
      scenario: "concurrent_create_20",
      iteration: 0,
      startedAt: new Date().toISOString(),
      ok: created.length === 20 && errors.length === 0,
      errorCode: errors[0],
      notes: `created=${created.length} errors=${JSON.stringify(errors.slice(0, 5))}`,
      workload: { created: created.length, errors: errors.length, readyMs: summarize(latencies) },
    } as SampleRow);
  }

  // 2. Repeated use of one purchased session.
  {
    const session = await createAndReady(bench, spec(opts, 300));
    const latencies: number[] = [];
    const failures: string[] = [];
    for (let i = 0; i < 100; i++) {
      const r = await timedExec(bench, session.handle, ["bash", "-c", "echo tick"]);
      if (r.result && r.result.exitCode === 0) latencies.push(r.ms);
      else failures.push(r.errorCode ?? `exit ${r.result?.exitCode}`);
    }
    const first = summarize(latencies.slice(0, 20));
    const last = summarize(latencies.slice(-20));
    await timedDestroy(bench, session.handle);
    record(bench, out, {
      scenario: "repeated_exec_100",
      iteration: 0,
      startedAt: new Date().toISOString(),
      ok: failures.length === 0,
      notes: `failures=${failures.length} p50_first=${fmtMs(first?.p50)} p50_last=${fmtMs(last?.p50)} drift=${(last?.p50 ?? 0) - (first?.p50 ?? 0)}ms`,
      workload: { n: latencies.length, failures: failures.length, latency: summarize(latencies) },
    } as SampleRow);
  }

  // 3. Expiration during execution (termination latency, cleanup).
  {
    const session = await createAndReady(bench, spec(opts, 4));
    const leaseEnd = session.status.leaseExpiresAt ? Date.parse(session.status.leaseExpiresAt) : Date.now() + 4000;
    const running = timedExec(bench, session.handle, ["bash", "-c", "echo starting; sleep 60"], { timeoutMs: 120_000 });
    const gone = await waitForPodGone(session.sessionId, 120_000);
    const finished = await running;
    record(bench, out, {
      scenario: "expiry_during_exec",
      iteration: 0,
      startedAt: new Date().toISOString(),
      ok: gone !== null,
      notes: `pod gone ${fmtMs(gone)} after lease start; exec ${finished.result ? "returned" : "failed:" + finished.errorCode}`,
      workload: {
        podGoneAfterLeaseMs: gone === null ? -1 : Date.now() - leaseEnd,
        cancelled: Boolean(finished.result?.cancelled || finished.result?.timedOut),
      },
    } as SampleRow);
  }

  // 4. Controller restart under load.
  {
    const sessions = await mapLimit(Array.from({ length: 5 }, (_, i) => i), 5, () => createAndReady(bench, spec(opts, 120)));
    let stop = false;
    const loops = sessions.map(async (s) => {
      let errors = 0;
      let ok = 0;
      while (!stop) {
        const r = await timedExec(bench, s.handle, ["bash", "-c", "echo tick"]);
        if (r.result) ok++;
        else errors++;
        await sleep(120);
      }
      return { ok, errors };
    });
    await sleep(1000);
    const t0 = performance.now();
    deletePods("app=controller");
    await waitDeployment("controller", 120_000);
    const recoveryMs = performance.now() - t0;
    await sleep(3000);
    stop = true;
    const counts = await Promise.all(loops);
    let probeAfter = false;
    try {
      const probe = await timedExec(bench, sessions[0]!.handle, ["bash", "-c", "echo recovered"]);
      probeAfter = Boolean(probe.result);
    } catch {
      probeAfter = false;
    }
    for (const s of sessions) await bench.client.destroy(s.handle, 60_000).catch(() => null);
    const totalErrors = counts.reduce((a, c) => a + c.errors, 0);
    record(bench, out, {
      scenario: "controller_restart_under_load",
      iteration: 0,
      startedAt: new Date().toISOString(),
      ok: probeAfter,
      notes: `recovery ${fmtMs(recoveryMs)}, exec errors during outage ${totalErrors}, probe after=${probeAfter}`,
      workload: { recoveryMs, errors: totalErrors, ok: counts.reduce((a, c) => a + c.ok, 0) },
    } as SampleRow);
  }

  // 5. Relay restart during an active session.
  {
    const session = await createAndReady(bench, spec(opts, 120));
    deletePods("app=relay");
    const relayBack = await waitDeployment("relay", 120_000);
    const after = await timedExec(bench, session.handle, ["bash", "-c", "echo after-relay"]);
    // Observe whether the control plane notices the dead guest; record it.
    await sleep(3000);
    const state = await bench.client.status(session.handle).catch(() => null);
    await bench.client.destroy(session.handle, 60_000).catch(() => null);
    record(bench, out, {
      scenario: "relay_restart",
      iteration: 0,
      startedAt: new Date().toISOString(),
      ok: relayBack,
      notes: `exec after restart: ${after.result ? "ok" : after.errorCode}; session state before destroy: ${state?.state ?? "unknown"}`,
      workload: {
        relayBack,
        execOk: Boolean(after.result),
        stateAfter: state?.state ?? "unknown",
      },
    } as SampleRow);
  }

  // 6. API restart with in-flight creates.
  {
    const inflight = mapLimit(Array.from({ length: 10 }, (_, i) => i), 10, async () => {
      try {
        const h = await bench.client.createSession(spec(opts, 120));
        return { h };
      } catch (err) {
        return { error: (err as { code?: string }).code ?? "create_failed" };
      }
    });
    await sleep(300);
    deletePods("app=api");
    const results = await inflight;
    const apiBack = await waitDeployment("api", 120_000);
    await sleep(1000);
    const created = results.filter((r) => "h" in r && r.h).map((r) => (r as { h: any }).h);
    const errors = results.filter((r) => "error" in r).map((r) => (r as { error: string }).error);
    for (const h of created) await bench.client.destroy(h, 60_000).catch(() => null);
    let newCreate = false;
    try {
      const h = await bench.client.createSession(spec(opts, 60));
      newCreate = true;
      await bench.client.destroy(h, 60_000).catch(() => null);
    } catch {
      newCreate = false;
    }
    record(bench, out, {
      scenario: "api_restart_inflight",
      iteration: 0,
      startedAt: new Date().toISOString(),
      ok: apiBack && newCreate,
      notes: `in-flight created=${created.length} errors=${errors.length}; api back=${apiBack}; new create=${newCreate}`,
      workload: { created: created.length, errors: errors.length, apiBack, newCreate },
    } as SampleRow);
  }

  // 7. Cancellation during execution.
  {
    const session = await createAndReady(bench, spec(opts, 120));
    const requestId = "bench-cancel-request-01";
    const pending = bench.client
      .exec(session.handle, {
        command: ["bash", "-c", "echo start; sleep 30"],
        requestId,
        timeoutMs: 120_000,
      })
      .catch((err: unknown) => err);
    await sleep(700);
    await bench.client.cancel(session.handle, requestId).catch(() => undefined);
    const finished = (await pending) as { ok?: boolean; cancelled?: boolean; error?: { code?: string } };
    const stillUsable = await timedExec(bench, session.handle, ["bash", "-c", "echo alive"]);
    await timedDestroy(bench, session.handle);
    record(bench, out, {
      scenario: "cancellation",
      iteration: 0,
      startedAt: new Date().toISOString(),
      ok: stillUsable.result !== null,
      notes: `cancelled=${finished.cancelled ?? false}, session usable after=${stillUsable.result !== null}`,
      workload: { cancelled: Boolean(finished.cancelled), usableAfter: Boolean(stillUsable.result) },
    } as SampleRow);
  }

  // 8. Client disconnect and recovery by request id.
  {
    const session = await createAndReady(bench, spec(opts, 120));
    const controller = new AbortController();
    const requestId = "bench-disconnect-0001";
    const pending = bench.client
      .exec(session.handle, {
        command: ["bash", "-c", "sleep 2; echo finished-after-disconnect"],
        requestId,
        signal: controller.signal,
      })
      .catch((err: unknown) => err);
    await sleep(400);
    controller.abort();
    await pending;
    const result = await bench.client.getOperation(session.handle, requestId, 30_000).catch(() => null);
    await timedDestroy(bench, session.handle);
    record(bench, out, {
      scenario: "client_disconnect",
      iteration: 0,
      startedAt: new Date().toISOString(),
      ok: Boolean(result?.ok),
      notes: result?.ok ? "result recovered by request id" : "result not recovered",
      workload: { recovered: Boolean(result?.ok) },
    } as SampleRow);
  }

  // 9. Pod killed while READY (partial provisioning / node-level failure).
  {
    const session = await createAndReady(bench, spec(opts, 120));
    kubectl(["-n", "sandbox-workloads", "delete", "pod", `sbx-${session.sessionId.replace(/^sbx_/, "")}`, "--grace-period=0", "--force"]);
    let state = "unknown";
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      const s = await bench.client.status(session.handle).catch(() => null);
      if (s && ["FAILED", "EXPIRED", "DESTROYED"].includes(s.state)) {
        state = s.state;
        break;
      }
      state = s?.state ?? state;
    }
    await bench.client.destroy(session.handle, 30_000).catch(() => null);
    record(bench, out, {
      scenario: "pod_killed_while_ready",
      iteration: 0,
      startedAt: new Date().toISOString(),
      ok: ["FAILED", "EXPIRED", "DESTROYED"].includes(state),
      notes: `state after pod kill: ${state} (waited 60s)`,
      workload: { finalState: state },
    } as SampleRow);
  }

  // 10. Final orphan check.
  await waitForNoSandboxPods(30_000);
  const orphans = sandboxPodCount();
  out.orphans = orphans;
  record(bench, out, {
    scenario: "orphan_check",
    iteration: 0,
    startedAt: new Date().toISOString(),
    ok: orphans === 0,
    notes: `${orphans} sandbox pod(s) remain`,
  });

  bench.writeJson("reliability.summary.json", out);
  if (!opts.json) {
    process.stdout.write("\nreliability\n");
    for (const [name, row] of Object.entries(out)) {
      const r = row as SampleRow;
      process.stdout.write(
        `${name.padEnd(32)} ok=${String(r.ok).padEnd(5)} ${r.notes ?? ""}\n`,
      );
    }
  }
  return 0;
}

