/**
 * Millisecond-resolution pod event watcher.
 *
 * Kubernetes timestamps (`creationTimestamp`, condition `lastTransitionTime`,
 * container `startedAt`) are RFC3339 with second precision, which is useless for
 * a 1-2 s lifecycle. This watcher consumes the pod watch stream and stamps the
 * *observation* time in the harness process (same clock as the client), giving
 * sub-100 ms resolution for ADDED -> Scheduled -> Running -> terminal.
 *
 * It is operator-side benchmark tooling, not part of the service.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { KUBECTL_CONTEXT, SANDBOX_NS } from "./env.js";

export interface PodMarks {
  addedAt?: number;
  scheduledAt?: number;
  runningAt?: number;
  finishedAt?: number;
}

export class PodWatcher {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private readonly marks = new Map<string, PodMarks>();
  private readonly startedAt = performance.now();

  start(): void {
    this.proc = spawn("kubectl", [
      "--context",
      KUBECTL_CONTEXT,
      "-n",
      SANDBOX_NS,
      "get",
      "pods",
      "-w",
      "--output-watch-events",
      "-o",
      "json",
      "--request-timeout=0",
    ]);
    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => {
      const at = performance.now() - this.startedAt;
      try {
        const event = JSON.parse(line) as { type: string; object: any };
        const name: string | undefined = event.object?.metadata?.name;
        if (!name) return;
        const entry = this.marks.get(name) ?? {};
        if (event.type === "ADDED" || event.type === "MODIFIED") {
          if (entry.addedAt === undefined) entry.addedAt = at;
          const conditions = event.object?.status?.conditions ?? [];
          const scheduled = conditions.find((c: any) => c.type === "PodScheduled" && c.status === "True");
          if (scheduled && entry.scheduledAt === undefined) entry.scheduledAt = at;
          const running = (event.object?.status?.containerStatuses ?? []).some(
            (c: any) => c.name === "guest" && c.state?.running,
          );
          if (running && entry.runningAt === undefined) entry.runningAt = at;
          if (["Succeeded", "Failed"].includes(event.object?.status?.phase) && entry.finishedAt === undefined) {
            entry.finishedAt = at;
          }
        }
        this.marks.set(name, entry);
      } catch {
        /* partial line */
      }
    });
    this.proc.stderr.on("data", () => undefined);
  }

  /** Times are relative to watcher.start(); convert with `sinceStart(ms)`. */
  get(podName: string): PodMarks {
    return this.marks.get(podName) ?? {};
  }

  sinceStart(at: number | undefined): number | undefined {
    return at === undefined ? undefined : at;
  }

  /** Absolute harness-clock timestamp for an event. */
  absolute(at: number | undefined): number | undefined {
    return at === undefined ? undefined : this.startedAt + at;
  }

  async waitForRunning(podName: string, timeoutMs = 10_000): Promise<PodMarks> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const marks = this.get(podName);
      if (marks.runningAt !== undefined) return marks;
      await new Promise((r) => setTimeout(r, 25));
    }
    return this.get(podName);
  }

  get base(): number {
    return this.startedAt;
  }

  stop(): void {
    try {
      this.proc?.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    this.proc = null;
  }
}
