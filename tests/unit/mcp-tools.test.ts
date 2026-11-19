/**
 * The MCP surface: what the tools accept, and what they refuse.
 *
 * These tools spend money on the caller's behalf, so the refusals matter more
 * than the happy path: a path that escapes the workspace, an empty command and
 * a timeout outside the tool's own schema must fail before a session is paid
 * for, not after.
 */
import { describe, expect, it, vi } from "vitest";
import { loadMcpConfig } from "../../mcp/src/config.js";
import {
  commandArgv,
  readPricing,
  renderRun,
  runOne,
  workspaceFiles,
} from "../../mcp/src/tools.js";

const CONFIG = loadMcpConfig({ PAYMENT_MODE: "mock" });

describe("the workspace file map", () => {
  it("keeps relative paths and their contents", () => {
    expect(workspaceFiles([{ path: "app/main.py", content: "print(1)" }])).toEqual({
      "app/main.py": "print(1)",
    });
  });

  it("refuses a path that leaves the workspace", () => {
    expect(() => workspaceFiles([{ path: "../etc/passwd", content: "" }])).toThrow(/workspace-relative/);
    expect(() => workspaceFiles([{ path: "/etc/passwd", content: "" }])).toThrow(/workspace-relative/);
  });

  it("returns an empty map when no files are given", () => {
    expect(workspaceFiles(undefined)).toEqual({});
    expect(workspaceFiles([])).toEqual({});
  });
});

describe("the command line", () => {
  it("runs through the shell, so quoting stays the caller's", () => {
    expect(commandArgv("python3 -c 'print(1)'")).toEqual(["/bin/sh", "-lc", "python3 -c 'print(1)'"]);
  });

  it("refuses an empty command rather than buying a box for it", () => {
    expect(() => commandArgv("   ")).toThrow(/empty/);
  });
});

describe("the result an agent reads", () => {
  const base = {
    sessionId: "sbx_1",
    exitCode: 0,
    stdout: "hello\n",
    stderr: "",
    files: {},
    durationMs: 812,
    timedOut: false,
    cancelled: false,
  };

  it("reports the exit code, the session and the output", () => {
    const text = renderRun(base);
    expect(text).toContain("exit 0");
    expect(text).toContain("sbx_1");
    expect(text).toContain("hello");
  });

  it("names a timeout instead of reporting a plain non-zero exit", () => {
    expect(renderRun({ ...base, exitCode: 124, timedOut: true })).toContain("exit 124 (timed out)");
  });

  it("omits empty streams and lists returned files", () => {
    const text = renderRun({ ...base, files: { "out/result.json": new Uint8Array() } });
    expect(text).not.toContain("stderr:");
    expect(text).toContain("out/result.json");
  });
});

describe("one paid run", () => {
  it("passes the tier, the files and a bounded timeout to the client", async () => {
    const run = vi.fn(async () => ({
      sessionId: "s",
      exitCode: 0,
      stdout: "",
      stderr: "",
      files: {},
      durationMs: 1,
      timedOut: false,
      cancelled: false,
    }));
    await runOne({ run } as never, CONFIG, {
      command: "echo hi",
      tier: "standard",
      files: [{ path: "a.txt", content: "x" }],
      timeoutSeconds: 30,
    });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        command: ["/bin/sh", "-lc", "echo hi"],
        tier: "standard",
        files: { "a.txt": "x" },
        timeoutMs: 30_000,
      }),
    );
  });

  it("caps a timeout the caller set above the server's own ceiling", async () => {
    const run = vi.fn(async () => ({}) as never);
    await runOne({ run } as never, { ...CONFIG, maxCommandSeconds: 60 }, {
      command: "sleep 600",
      timeoutSeconds: 3_600,
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 60_000 }));
  });
});

describe("the pricing tool", () => {
  it("reports a non-OK answer instead of pretending to have a price", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    try {
      await expect(readPricing("https://api.test")).rejects.toThrow(/503/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("the environment", () => {
  it("defaults to the hosted service and the cheapest tier", () => {
    expect(CONFIG).toMatchObject({
      apiUrl: "https://api.throwbox.dev",
      paymentMode: "mock",
      defaultTier: "short",
    });
  });

  it("strips a trailing slash so the resource URL has no double slash", () => {
    const config = loadMcpConfig({ PAYMENT_MODE: "mock", THROWBOX_API_URL: "https://api.test/" });
    expect(config.apiUrl).toBe("https://api.test");
  });

  it("refuses to start without a wallet for a real network", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      loadMcpConfig({ PAYMENT_MODE: "testnet" });
      expect(exit).toHaveBeenCalledWith(1);
      expect(stderr.mock.calls.flat().join("")).toContain("EVM_PRIVATE_KEY");
    } finally {
      exit.mockRestore();
      stderr.mockRestore();
    }
  });

  it("refuses mainnet until real money is confirmed", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      loadMcpConfig({ PAYMENT_MODE: "mainnet", EVM_PRIVATE_KEY: `0x${"a".repeat(64)}` });
      expect(exit).toHaveBeenCalledWith(1);
      expect(stderr.mock.calls.flat().join("")).toContain("CONFIRM_REAL_MONEY");
    } finally {
      exit.mockRestore();
      stderr.mockRestore();
    }
  });
});
