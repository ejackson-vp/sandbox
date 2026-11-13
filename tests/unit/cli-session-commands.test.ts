/**
 * Session lifecycle commands: create, status, suspend, resume and destroy.
 *
 * Split out of cli-commands.test.ts. These handlers own a session from payment
 * to teardown, so they are read together: what create maps its flags to, what
 * status prints and what it omits, and that a state change reports the state
 * the server returned. The scratch directory, output capture and `run` helper
 * come from support/cli-commands.ts; the commands that move bytes or run
 * workloads are their own files.
 */
import { describe, expect, it, vi } from "vitest";
import { fakeClient, SESSION_ID, sessionHandle, sessionStatus } from "./helpers/cli.js";
import { cliFixture } from "./support/cli-commands.js";

const cli = cliFixture();

describe("create", () => {
  it("pays, waits for ready and reports the lease", async () => {
    const client = fakeClient();
    client.createSession.mockImplementation(async () => ({ ...sessionHandle(), status: sessionStatus() }));
    const { code, out } = await cli.run("create", client);
    expect(code).toBe(0);
    expect(client.createSession).toHaveBeenCalledWith({});
    expect(client.waitForReady).toHaveBeenCalledTimes(1);
    expect(out).toContain(`Session: ${SESSION_ID}`);
    expect(out).toContain("Tier: standard (300s, 1000m CPU, 1024Mi RAM, 1024Mi disk)");
    expect(out).toContain("Price: $0.05 (mock payment)");
    expect(out).toContain("Evidence: none (session key binding, no hardware root of trust)");
    expect(out).toContain("Expires: ? (120s remaining)");
  });

  it("falls back to PAID and an unknown price when the create response omits status", async () => {
    const { out } = await cli.run("create", fakeClient());
    expect(out).toContain("State: PAID");
    expect(out).toContain("Price: ? (mock payment)");
    expect(out).not.toContain("Tier:");
  });

  it("skips the wait with --no-wait", async () => {
    const client = fakeClient();
    const { out } = await cli.run("create", client, { values: { "no-wait": true } });
    expect(client.waitForReady).not.toHaveBeenCalled();
    expect(out).not.toContain("Evidence:");
  });

  it("emits one JSON object with --json", async () => {
    const client = fakeClient();
    client.createSession.mockImplementation(async () => ({ ...sessionHandle(), status: sessionStatus() }));
    const { out } = await cli.run("create", client, { json: true });
    const parsed = JSON.parse(out) as { sessionId: string; status: { state: string } };
    expect(parsed.sessionId).toBe(SESSION_ID);
    expect(parsed.status.state).toBe("READY");
    expect(out).not.toContain("Session: ");
  });

  it.each([
    [{ duration: "15m" }, { tier: "extended", durationSeconds: 900 }],
    [{ duration: "60s" }, { tier: "short", durationSeconds: 60 }],
    [{ duration: "1800" }, { tier: "long", durationSeconds: 1800 }],
    [{ duration: "45s" }, { tier: "custom", durationSeconds: 45 }],
    [{ duration: "1h" }, { tier: "custom", durationSeconds: 3600 }],
    [{ tier: "long", duration: "15m" }, { tier: "long", durationSeconds: 900 }],
    [{ tier: "standard" }, { tier: "standard" }],
    [{ cpu: "1" }, { cpuMillis: 1000 }],
    [{ cpu: "0.25" }, { cpuMillis: 250 }],
    [{ memory: "2Gi" }, { memoryMiB: 2048 }],
    [{ memory: "512Mi" }, { memoryMiB: 512 }],
    [{ memory: "512" }, { memoryMiB: 512 }],
    [{ disk: "1Gi" }, { diskMiB: 1024 }],
    [{ "baseline-cpu": "0.25" }, { baselineCpuMillis: 250 }],
    [{ "baseline-memory": "256Mi" }, { baselineMemoryMiB: 256 }],
    [{ "max-lifetime": "8h" }, { maxLifetimeSeconds: 28800 }],
    [{ runtime: "python" }, { runtime: "python" }],
    [
      { idle: "5m" },
      { idlePolicy: { maxIdleSeconds: 300, suspendedDurationSeconds: 28800, autoResume: false } },
    ],
    [
      { duration: "15m", cpu: "2", memory: "4Gi", idle: "1m", runtime: "node" },
      {
        tier: "extended",
        durationSeconds: 900,
        cpuMillis: 2000,
        memoryMiB: 4096,
        idlePolicy: { maxIdleSeconds: 60, suspendedDurationSeconds: 28800, autoResume: false },
        runtime: "node",
      },
    ],
  ])("maps %j to create options", async (values, expected) => {
    const client = fakeClient();
    await cli.run("create", client, { values: values as Record<string, string> });
    expect(client.createSession).toHaveBeenCalledWith(expected);
  });

  it.each([
    [{ duration: "15x" }, "invalid duration: 15x"],
    [{ duration: "-5m" }, "invalid duration: -5m"],
    [{ memory: "2GB" }, "invalid memory: 2GB"],
    [{ disk: "2 GB" }, "invalid memory: 2 GB"],
    [{ cpu: "0" }, "invalid cpu: 0"],
    [{ cpu: "lots" }, "invalid cpu: lots"],
  ])("rejects %j with %s", async (values, message) => {
    const client = fakeClient();
    await expect(cli.run("create", client, { values: values as Record<string, string> })).rejects.toThrow(
      message,
    );
    expect(client.createSession).not.toHaveBeenCalled();
  });
});

describe("status", () => {
  it("prints the summary and every optional section", async () => {
    const client = fakeClient({
      status: vi.fn(async () =>
        sessionStatus({
          readyAt: "2026-01-01T00:00:01.000Z",
          leaseExpiresAt: "2026-01-01T00:05:00.000Z",
          baseline: { cpuMillis: 250, memoryMiB: 256 },
          idlePolicy: { maxIdleSeconds: 300, autoResume: true },
          suspendedAt: "2026-01-01T00:02:00.000Z",
          resumeCount: 2,
          failure: { code: "guest_crash", message: "the guest died" },
        }),
      ),
    });
    const { code, out } = await cli.run("status", client, { positionals: ["status", SESSION_ID] });
    expect(code).toBe(0);
    expect(out).toContain(`Session: ${SESSION_ID}`);
    expect(out).toContain("State: READY");
    expect(out).toContain("Tier: standard (300s)");
    expect(out).toContain("Limits: 1000m CPU, 1024Mi RAM, 1024Mi disk");
    expect(out).toContain("Ready: 2026-01-01T00:00:01.000Z");
    expect(out).toContain("Expires: 2026-01-01T00:05:00.000Z (120s remaining)");
    expect(out).toContain("Baseline: 250m CPU, 256Mi RAM");
    expect(out).toContain("Idle policy: maxIdle 300s, autoResume true");
    expect(out).toContain("Suspended: 2026-01-01T00:02:00.000Z");
    expect(out).toContain("Resumes: 2");
    expect(out).toContain("Failure: guest_crash: the guest died");
    expect(out).toContain("Busy: false");
  });

  it("omits sections that are absent", async () => {
    const { out } = await cli.run("status", fakeClient(), { positionals: ["status", SESSION_ID] });
    expect(out).not.toContain("Ready:");
    expect(out).not.toContain("Baseline:");
    expect(out).not.toContain("Failure:");
  });

  it("emits the raw status with --json", async () => {
    const { out } = await cli.run("status", fakeClient(), {
      positionals: ["status", SESSION_ID],
      json: true,
    });
    expect((JSON.parse(out) as { sessionId: string }).sessionId).toBe(SESSION_ID);
  });

  it("requires a session id", async () => {
    await expect(cli.run("status", fakeClient(), { positionals: ["status"] })).rejects.toThrow(
      "missing session id",
    );
  });
});

describe("suspend and resume", () => {
  it("prints the new state", async () => {
    const { code, out } = await cli.run("suspend", fakeClient(), {
      positionals: ["suspend", SESSION_ID],
    });
    expect(code).toBe(0);
    expect(out).toBe("State: SUSPENDED\n");
  });

  it("prints the resume state and JSON body", async () => {
    const { code, out } = await cli.run("resume", fakeClient(), {
      positionals: ["resume", SESSION_ID],
      json: true,
    });
    expect(code).toBe(0);
    expect(out).not.toContain("State: READY");
    expect((JSON.parse(out) as { resumeCount: number }).resumeCount).toBe(1);
  });
});

describe("destroy", () => {
  it("reports the destroyed state", async () => {
    const { code, out } = await cli.run("destroy", fakeClient(), {
      positionals: ["destroy", SESSION_ID],
    });
    expect(code).toBe(0);
    expect(out).toBe("Sandbox: destroyed\n");
  });

  it("handles a client that returns no status", async () => {
    const client = fakeClient({ destroy: vi.fn(async () => null) });
    const { out } = await cli.run("destroy", client, { positionals: ["destroy", SESSION_ID] });
    expect(out).toBe("Sandbox: destroyed\n");
  });

  it("emits the id and state with --json", async () => {
    const { out } = await cli.run("destroy", fakeClient(), {
      positionals: ["destroy", SESSION_ID],
      json: true,
    });
    expect(JSON.parse(out)).toEqual({ sessionId: SESSION_ID, state: "DESTROYED" });
  });
});
