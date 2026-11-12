/**
 * Argument parsing, early commands and exit codes for the `sandbox` entry point.
 *
 * `main` takes an explicit argv so these run without spawning a process: the
 * point is the mapping from an argument vector to stdout, stderr and an exit
 * code, and a subprocess would only add startup cost to that.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, reportFatal } from "../../cli/src/index.js";
import { HELP } from "../../cli/src/commands.js";
import { FileSessionStore } from "../../sdk/src/session-store.js";
// Import the built package, not sdk/src: the CLI resolves @x402s/sdk to
// sdk/dist, and an instanceof check needs the same class identity.
import { SandboxError, SessionExpiredError } from "@x402s/sdk";
import { captureWrites, SESSION_ID } from "./helpers/cli.js";

let capture: ReturnType<typeof captureWrites>;
let home: string;
const MANAGED_ENV = ["X402_SANDBOX_HOME", "CONTROLLER_URL", "CONTROLLER_ADMIN_TOKEN", "ADMIN_TOKEN"];
const savedEnv = new Map(MANAGED_ENV.map((key) => [key, process.env[key]]));

beforeEach(() => {
  capture = captureWrites();
  home = mkdtempSync(join(tmpdir(), "x402-cli-home-"));
  process.env.X402_SANDBOX_HOME = home;
});

afterEach(() => {
  capture.restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

async function invoke(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const code = await main(argv);
  return { code, out: capture.stdout(), err: capture.stderr() };
}

function stubFetch(impl: (url: string, init?: RequestInit) => Partial<Response>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) =>
    impl(String(input), init),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("help and version", () => {
  it("prints usage when there is no command", async () => {
    const { code, out, err } = await invoke([]);
    expect(code).toBe(0);
    expect(out).toBe(HELP);
    expect(err).toBe("");
  });

  it.each([["help"], ["--help"], ["-h"]])("prints usage for %s", async (flag) => {
    const { code, out } = await invoke([flag]);
    expect(code).toBe(0);
    expect(out).toBe(HELP);
  });

  it("prints usage when help is combined with a command", async () => {
    const { code, out } = await invoke(["destroy", "--help"]);
    expect(code).toBe(0);
    expect(out).toBe(HELP);
  });

  it("prints the version", async () => {
    const { code, out } = await invoke(["version"]);
    expect(code).toBe(0);
    expect(out).toBe("sandbox 0.2.0\n");
  });
});

describe("rejected argument vectors", () => {
  it("returns 2 for an unknown command and repeats the usage", async () => {
    const { code, out, err } = await invoke(["wat"]);
    expect(code).toBe(2);
    expect(err).toContain("unknown command: wat");
    expect(err).toContain(HELP);
    expect(out).toBe("");
  });

  it("rejects an unknown option before dispatch", async () => {
    await expect(main(["--nope"])).rejects.toThrow(/Unknown option/);
  });

  it("rejects a payment mode that is not mock or testnet", async () => {
    const { code, err } = await invoke(["create", "--payment-mode", "sepa"]);
    expect(code).toBe(2);
    expect(err).toBe("invalid --payment-mode: sepa\n");
  });

  it("checks the payment mode before it looks up the command", async () => {
    const { code, err } = await invoke(["wat", "--payment-mode", "sepa"]);
    expect(code).toBe(2);
    expect(err).toBe("invalid --payment-mode: sepa\n");
  });
});

describe("admin capacity", () => {
  it("requires the capacity subcommand", async () => {
    const { code, err } = await invoke(["admin"]);
    expect(code).toBe(2);
    expect(err).toBe("usage: sandbox admin capacity\n");
  });

  it("calls the controller with the admin token and pretty-prints the body", async () => {
    process.env.CONTROLLER_URL = "http://controller.test:9999";
    process.env.CONTROLLER_ADMIN_TOKEN = "secret-token";
    const fetchMock = stubFetch(() => ({ ok: true, json: async () => ({ capacity: { pods: 3 } }) }));

    const { code, out } = await invoke(["admin", "capacity"]);
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://controller.test:9999/internal/capacity");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toEqual({ "x-internal-token": "secret-token" });
    expect(out).toBe(`${JSON.stringify({ capacity: { pods: 3 } }, null, 2)}\n`);
  });

  it("falls back to ADMIN_TOKEN and then to an empty token", async () => {
    delete process.env.CONTROLLER_ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = "legacy";
    const fetchMock = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    await invoke(["admin", "capacity"]);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toEqual({ "x-internal-token": "legacy" });
  });

  it("returns 1 when the controller is unhappy", async () => {
    stubFetch(() => ({ ok: false, json: async () => ({ error: "unauthorised" }) }));
    const { code, out } = await invoke(["admin", "capacity"]);
    expect(code).toBe(1);
    expect(out).toContain("unauthorised");
  });

  it("does not fail when the error body is not JSON", async () => {
    stubFetch(() => ({
      ok: false,
      json: async () => {
        throw new Error("not json");
      },
    }));
    const { code, out } = await invoke(["admin", "capacity"]);
    expect(code).toBe(1);
    expect(out).toBe("{}\n");
  });
});

describe("pricing", () => {
  it("prints the price list from the API", async () => {
    const fetchMock = stubFetch(() => ({ ok: true, json: async () => ({ tiers: [{ tier: "short" }] }) }));
    const { code, out } = await invoke(["pricing"]);
    expect(code).toBe(0);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://localhost:8080/v1/pricing");
    expect(out).toBe(`${JSON.stringify({ tiers: [{ tier: "short" }] }, null, 2)}\n`);
  });

  it("honours --api-url", async () => {
    const fetchMock = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    await invoke(["pricing", "--api-url", "http://api.test:1234"]);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://api.test:1234/v1/pricing");
  });

  it("returns 1 when the API rejects the request", async () => {
    stubFetch(() => ({ ok: false, json: async () => ({}) }));
    const { code } = await invoke(["pricing"]);
    expect(code).toBe(1);
  });
});

describe("sessions", () => {
  const stored = {
    apiUrl: "http://localhost:8080",
    sessionId: SESSION_ID,
    capability: "cap",
    clientPublicKey: "pk",
    clientPrivateKey: "sk",
    clientNonce: "nonce",
    createdAt: 1_767_225_600_000,
    tier: "standard",
  };

  it("says so when nothing is stored locally", async () => {
    const { code, out } = await invoke(["sessions"]);
    expect(code).toBe(0);
    expect(out).toBe("no locally stored sessions\n");
  });

  it("lists stored handles from X402_SANDBOX_HOME", async () => {
    new FileSessionStore(home).save(stored);
    const { code, out } = await invoke(["sessions"]);
    expect(code).toBe(0);
    expect(out).toBe(
      `${SESSION_ID}  standard  created ${new Date(stored.createdAt).toISOString()}  http://localhost:8080\n`,
    );
  });

  it("marks a handle with no recorded tier", async () => {
    new FileSessionStore(home).save({ ...stored, tier: undefined });
    const { out } = await invoke(["sessions"]);
    expect(out).toContain(`${SESSION_ID}  ?  created`);
  });

  it("emits the rows as JSON with --json", async () => {
    new FileSessionStore(home).save(stored);
    const { out } = await invoke(["sessions", "--json"]);
    const rows = JSON.parse(out) as Array<{ sessionId: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sessionId).toBe(SESSION_ID);
  });
});

describe("dispatch into the command registry", () => {
  it("builds the context and runs the handler", async () => {
    // exec with an id but no command reaches the handler and stops at its own
    // validation, which proves argv reached it without opening a socket.
    const { code, err } = await invoke(["exec", SESSION_ID]);
    expect(code).toBe(2);
    expect(err).toContain("missing command; use: sandbox exec");
  });

  it("propagates a handler argument error", async () => {
    await expect(main(["status"])).rejects.toThrow("missing session id");
  });

  it("propagates a handler validation error from run", async () => {
    await expect(main(["run"])).rejects.toThrow("missing file");
  });

  it("uses -- as the one-shot marker", async () => {
    // `run` with no `--` is the legacy file form and wants a file. With `--`
    // it is the one-shot form and wants a command, which is the observable
    // difference between the two paths.
    await expect(main(["run"])).rejects.toThrow("missing file");
    const { code, err } = await invoke(["run", "--"]);
    expect(code).toBe(2);
    expect(err).toContain("missing command; use: sandbox run");
  });

  it("collects a repeated --env into a list", async () => {
    // A stored handle gets the dispatcher as far as parseEnv, which runs before
    // any request. The error names the whole entry: a single string would have
    // been split into characters and failed on "N".
    new FileSessionStore(home).save({
      apiUrl: "http://localhost:8080",
      sessionId: SESSION_ID,
      capability: "cap",
      clientPublicKey: Buffer.alloc(32).toString("base64"),
      clientPrivateKey: Buffer.alloc(32).toString("base64"),
      clientNonce: "nonce",
      createdAt: 0,
    });
    await expect(
      main(["exec", SESSION_ID, "--env", "A=1", "--env", "NOVALUE", "true"]),
    ).rejects.toThrow("invalid --env NOVALUE (expected KEY=VALUE)");
  });
});

describe("reportFatal maps errors to exit codes", () => {
  it("maps a session lease that has ended to 124", async () => {
    expect(reportFatal(new SessionExpiredError())).toBe(124);
    expect(capture.stderr()).toBe("error: the session lease has ended\n");
  });

  it("maps a sandbox error to 1 with its code", async () => {
    expect(reportFatal(new SandboxError("payment_required", "pay up"))).toBe(1);
    expect(capture.stderr()).toBe("error: payment_required: pay up\n");
  });

  it("maps anything else to 1 as a fatal error", async () => {
    expect(reportFatal(new Error("boom"))).toBe(1);
    expect(capture.stderr()).toBe("fatal: boom\n");
  });

  it("prefers the lease code over the generic sandbox code", () => {
    const expired = new SessionExpiredError("gone");
    expect(expired).toBeInstanceOf(SandboxError);
    expect(reportFatal(expired)).toBe(124);
    expect(capture.stderr()).toBe("error: gone\n");
  });
});
