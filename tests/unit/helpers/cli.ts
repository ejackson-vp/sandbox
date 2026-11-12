/**
 * Fakes for the CLI tests.
 *
 * `commands` takes a `SandboxClient` on its context, so the whole registry can
 * run against a stub with no server and no sockets. The stubs here return the
 * shapes the handlers read and record what they were called with, so a test can
 * assert the request the CLI would have made.
 */
import { vi } from "vitest";
import type { SessionHandle } from "../../../sdk/src/types.js";
import type { SandboxClient } from "../../../sdk/src/client.js";
import type { CommandContext } from "../../../cli/src/commands.js";
import type {
  ExecResult,
  FileEntry,
  FileGetResult,
  FileListResult,
  FilePutResult,
  FileStatResult,
  HttpResponseResult,
  OperationError,
  SessionStatus,
} from "@x402s/shared/protocol";

export const SESSION_ID = "sbx_0123456789abcdef01234567";

export function sessionHandle(sessionId = SESSION_ID): SessionHandle {
  return {
    sessionId,
    capability: "cap",
    clientPublicKey: new Uint8Array(32),
    clientPrivateKey: new Uint8Array(32),
    clientNonce: "nonce",
    createdAt: 0,
  };
}

const base = { v: 2 as const, sessionId: SESSION_ID, clientNonce: "nonce", requestId: "req" };

export function sessionStatus(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    ...base,
    state: "READY",
    tier: "standard",
    durationSeconds: 300,
    limits: { cpuMillis: 1000, memoryMiB: 1024, diskMiB: 1024, maxOutputBytes: 1, maxFileBytes: 1 },
    createdAt: "2026-01-01T00:00:00.000Z",
    remainingSeconds: 120,
    busy: false,
    payment: {
      mode: "mock",
      network: "eip155:84532",
      scheme: "exact",
      asset: "0x0",
      amount: "50000",
      priceUsd: "$0.05",
      payTo: "0x0",
    },
    ...overrides,
  } as SessionStatus;
}

export function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    ...base,
    ok: true,
    op: "exec",
    exitCode: 0,
    stdout: "hello\n",
    stderr: "",
    timedOut: false,
    cancelled: false,
    durationMs: 12,
    truncated: { stdout: false, stderr: false },
    ...overrides,
  };
}

export function operationError(
  code = "guest_error",
  message = "it broke",
  op: OperationError["op"] = "exec",
): OperationError {
  return { ...base, ok: false, op, error: { code, message } };
}

export function fileEntry(overrides: Partial<FileEntry> = {}): FileEntry {
  return { path: "a.txt", size: 5, mode: 0o644, isDir: false, mtimeMs: 0, ...overrides };
}

export function putResult(path: string, data: Uint8Array): FilePutResult {
  return { ...base, ok: true, op: "file.put", path, bytesWritten: data.byteLength, filesWritten: 1 };
}

export function getResult(path: string, data: Buffer): FileGetResult {
  return { ...base, ok: true, op: "file.get", path, dataBase64: data.toString("base64"), size: data.length, archive: false };
}

export function listResult(path: string, entries: FileEntry[]): FileListResult {
  return {
    ...base,
    ok: true,
    op: "file.list",
    path,
    entries,
    totalBytes: entries.reduce((sum, e) => sum + e.size, 0),
  };
}

export function statResult(entry: FileEntry): FileStatResult {
  return { ...base, ok: true, op: "file.stat", entry };
}

export function httpResult(overrides: Partial<HttpResponseResult> = {}): HttpResponseResult {
  return {
    ...base,
    ok: true,
    op: "http.request",
    status: 200,
    headers: { "content-type": "text/plain" },
    bodyBase64: Buffer.from("ok").toString("base64"),
    truncated: false,
    ...overrides,
  } as HttpResponseResult;
}

export type FakeClient = {
  createSession: ReturnType<typeof vi.fn>;
  waitForReady: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  putFile: ReturnType<typeof vi.fn>;
  getFile: ReturnType<typeof vi.fn>;
  listFiles: ReturnType<typeof vi.fn>;
  statFile: ReturnType<typeof vi.fn>;
  suspend: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  startService: ReturnType<typeof vi.fn>;
  listServices: ReturnType<typeof vi.fn>;
  stopService: ReturnType<typeof vi.fn>;
  openHttpStream: ReturnType<typeof vi.fn>;
  http: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
};

/** A client where every method resolves to a plausible happy-path result. */
export function fakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  const client: FakeClient = {
    createSession: vi.fn(async () => sessionHandle()),
    waitForReady: vi.fn(async () => sessionStatus()),
    status: vi.fn(async () => sessionStatus()),
    exec: vi.fn(async () => execResult()),
    putFile: vi.fn(async (_handle: unknown, opts: { path: string; data: Uint8Array }) =>
      putResult(opts.path, opts.data),
    ),
    getFile: vi.fn(async (_handle: unknown, path: string) => getResult(path, Buffer.from("result"))),
    listFiles: vi.fn(async (_handle: unknown, path: string) => listResult(path, [fileEntry()])),
    statFile: vi.fn(async (_handle: unknown, path: string) => statResult(fileEntry({ path }))),
    suspend: vi.fn(async () => sessionStatus({ state: "SUSPENDED" })),
    resume: vi.fn(async () => sessionStatus({ state: "READY", resumeCount: 1 })),
    startService: vi.fn(async (_handle: unknown, opts: { name: string; port: number }) => ({
      name: opts.name,
      port: opts.port,
      pid: 42,
      state: "running" as const,
      startedAt: 0,
    })),
    listServices: vi.fn(async () => []),
    stopService: vi.fn(async () => undefined),
    openHttpStream: vi.fn(async () => ({
      streamId: "s1",
      status: 200,
      headers: {},
      read: vi.fn(async () => ({ chunk: Buffer.from("chunk"), done: true })),
      close: vi.fn(async () => undefined),
    })),
    http: vi.fn(async () => ({ status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("ok"), truncated: false })),
    destroy: vi.fn(async () => sessionStatus({ state: "DESTROYED" })),
    run: vi.fn(async () => ({
      sessionId: SESSION_ID,
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
      files: {},
      durationMs: 5,
      timedOut: false,
      cancelled: false,
    })),
    ...overrides,
  };
  return client;
}

/** Build the context `commands[name]` expects, around a fake client. */
export function cliContext(
  client: FakeClient,
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return {
    values: {},
    positionals: ["create"],
    apiUrl: "http://localhost:8080",
    json: false,
    quiet: false,
    paymentMode: "mock",
    client: client as unknown as SandboxClient,
    attach: (id: string) => sessionHandle(id),
    hasSeparator: false,
    ...overrides,
  };
}

/** Collect what the handlers write, instead of letting it reach the terminal. */
export function captureWrites(): {
  stdout: () => string;
  stderr: () => string;
  restore: () => void;
} {
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  });
  return {
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

