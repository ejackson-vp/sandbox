/**
 * `sandbox admin allowlist` (ADR 0013).
 *
 * The CLI is a thin client over the controller's admin routes: it validates
 * arguments before a request, sends the existing admin token and nothing else,
 * and reports the controller's answer or exit code unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../cli/src/index.js";
import { captureWrites } from "./helpers/cli.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const MANAGED_ENV = ["CONTROLLER_URL", "CONTROLLER_ADMIN_TOKEN", "ADMIN_TOKEN"];
const savedEnv = new Map(MANAGED_ENV.map((key) => [key, process.env[key]]));

let capture: ReturnType<typeof captureWrites>;

beforeEach(() => {
  capture = captureWrites();
  process.env.CONTROLLER_URL = "http://controller.test:9999";
  process.env.CONTROLLER_ADMIN_TOKEN = "admin-token";
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

describe("admin allowlist", () => {
  it("lists entries from the controller", async () => {
    const fetchMock = stubFetch({ entries: [{ address: ADDRESS, label: "owner-agent" }] });

    const { code, out } = await invoke(["admin", "allowlist"]);

    expect(code).toBe(0);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://controller.test:9999/internal/payer-allowlist");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      "x-internal-token": "admin-token",
    });
    expect(JSON.parse(out)).toMatchObject({ entries: [{ label: "owner-agent" }] });
  });

  it("adds an entry with the operator's ceilings", async () => {
    const fetchMock = stubFetch({ entry: { address: ADDRESS, label: "owner-agent" } });

    const { code } = await invoke([
      "admin",
      "allowlist",
      "add",
      ADDRESS,
      "--label",
      "owner-agent",
      "--max-tier",
      "long",
      "--max-concurrent",
      "3",
    ]);

    expect(code).toBe(0);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      address: ADDRESS,
      label: "owner-agent",
      maxTier: "long",
      maxConcurrent: 3,
    });
  });

  it("defaults to the standard tier and one concurrent session", async () => {
    const fetchMock = stubFetch({ entry: {} });
    await invoke(["admin", "allowlist", "add", ADDRESS, "--label", "friend"]);
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toMatchObject({
      maxTier: "standard",
      maxConcurrent: 1,
    });
  });

  it("disables an entry", async () => {
    const fetchMock = stubFetch({ ok: true, changed: true });
    const { code } = await invoke(["admin", "allowlist", "disable", ADDRESS]);

    expect(code).toBe(0);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      `http://controller.test:9999/internal/payer-allowlist/${ADDRESS}`,
    );
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("DELETE");
  });

  it.each([
    [["admin", "allowlist", "add", "0xnot-an-address", "--label", "x"], "invalid address"],
    [["admin", "allowlist", "add", ADDRESS], "--label is required"],
    [["admin", "allowlist", "add", ADDRESS, "--label", "x", "--max-tier", "custom"], "invalid --max-tier"],
    [["admin", "allowlist", "add", ADDRESS, "--label", "x", "--max-concurrent", "500"], "--max-concurrent"],
    [["admin", "allowlist", "disable", "nope"], "invalid address"],
    [["admin", "allowlist", "wat"], "usage"],
  ])("rejects %j before calling the controller", async (argv, message) => {
    const fetchMock = stubFetch({});

    const { code, err } = await invoke(argv);

    expect(code).toBe(2);
    expect(err).toContain(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 1 and prints the controller's answer when it refuses", async () => {
    stubFetch({ error: "unauthorized" }, false);
    const { code, out } = await invoke(["admin", "allowlist", "list"]);
    expect(code).toBe(1);
    expect(out).toContain("unauthorized");
  });

  it("falls back to ADMIN_TOKEN for the credential", async () => {
    delete process.env.CONTROLLER_ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = "legacy-admin";
    const fetchMock = stubFetch({ entries: [] });

    await invoke(["admin", "allowlist"]);

    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      "x-internal-token": "legacy-admin",
    });
  });
});
