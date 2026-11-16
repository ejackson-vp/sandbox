/**
 * `sandbox admin killswitch` (schema v21).
 *
 * The CLI is a thin client over the controller's admin routes: it validates its
 * arguments before a request, sends the existing admin token and nothing else,
 * and reports the controller's answer or exit code unchanged.
 *
 * The two local refusals are the ones that matter at 2am: a missing `--reason`
 * leaves the next person no context, and an `--until` in the past would write a
 * row that says "on" but behaves off. Both exit 2 without a round trip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../cli/src/index.js";
import { captureWrites } from "./helpers/cli.js";

const MANAGED_ENV = ["CONTROLLER_URL", "CONTROLLER_ADMIN_TOKEN", "ADMIN_TOKEN", "USER"];
const savedEnv = new Map(MANAGED_ENV.map((key) => [key, process.env[key]]));

let capture: ReturnType<typeof captureWrites>;

beforeEach(() => {
  capture = captureWrites();
  process.env.CONTROLLER_URL = "http://controller.test:9999";
  process.env.CONTROLLER_ADMIN_TOKEN = "admin-token";
  process.env.USER = "eric";
});

afterEach(() => {
  capture.restore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function invoke(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const code = await main(argv);
  return { code, out: capture.stdout(), err: capture.stderr() };
}

function stubFetch(body: unknown, ok = true): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({ ok, json: async () => body }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("admin killswitch", () => {
  it("shows the switch state", async () => {
    const fetchMock = stubFetch({
      switch: { enabled: true, reason: "incident", actor: "eric", expiresAt: null },
    });

    const { code, out } = await invoke(["admin", "killswitch"]);

    expect(code).toBe(0);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://controller.test:9999/internal/create-switch");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      "x-internal-token": "admin-token",
    });
    expect(JSON.parse(out)).toMatchObject({ switch: { enabled: true, reason: "incident" } });
  });

  it("enables with the reason, actor and expiry", async () => {
    const fetchMock = stubFetch({ switch: { enabled: true } });
    const until = new Date(Date.now() + 3_600_000).toISOString();

    const { code } = await invoke([
      "admin",
      "killswitch",
      "enable",
      "--reason",
      "payments: double-settling",
      "--until",
      until,
    ]);

    expect(code).toBe(0);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      reason: "payments: double-settling",
      actor: "eric",
      until,
    });
  });

  it("treats --until none as until disabled, and honours --actor", async () => {
    const fetchMock = stubFetch({ switch: { enabled: true } });

    const { code } = await invoke([
      "admin",
      "killswitch",
      "enable",
      "--reason",
      "abuse",
      "--until",
      "none",
      "--actor",
      "duty",
    ]);

    expect(code).toBe(0);
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({
      reason: "abuse",
      actor: "duty",
      until: null,
    });
  });

  it("refuses an --until in the past without calling the controller", async () => {
    const fetchMock = stubFetch({});

    const { code, err } = await invoke([
      "admin",
      "killswitch",
      "enable",
      "--reason",
      "incident",
      "--until",
      new Date(Date.now() - 60_000).toISOString(),
    ]);

    expect(code).toBe(2);
    expect(err).toContain("--until");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a missing --reason without calling the controller", async () => {
    const fetchMock = stubFetch({});

    const { code, err } = await invoke(["admin", "killswitch", "enable"]);

    expect(code).toBe(2);
    expect(err).toContain("--reason");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("disables with the actor", async () => {
    const fetchMock = stubFetch({ switch: { enabled: false } });

    const { code } = await invoke(["admin", "killswitch", "disable"]);

    expect(code).toBe(0);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(String(init.body))).toEqual({ actor: "eric" });
  });

  it("reports the controller's refusal as a failure exit", async () => {
    stubFetch({ error: "until_in_past" }, false);

    const { code } = await invoke([
      "admin",
      "killswitch",
      "enable",
      "--reason",
      "incident",
    ]);

    expect(code).toBe(1);
  });

  it("prints the usage for an unknown action", async () => {
    const { code, err } = await invoke(["admin", "killswitch", "pause"]);

    expect(code).toBe(2);
    expect(err).toContain("sandbox admin killswitch");
  });
});
