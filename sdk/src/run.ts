/**
 * One-shot run: create a fresh session, upload inputs, exec, download outputs,
 * and always destroy. Kept separate from the facade so the ordering and cleanup
 * contract can be tested with a small stub client.
 */
import { DEFAULT_RUNTIME, isSupportedRuntime, SUPPORTED_RUNTIMES } from "@x402s/shared/runtimes";
import type { ExecResult, FileGetResult, FilePutResult, OperationError } from "@x402s/shared/protocol";
import { SandboxError } from "./types.js";
import type {
  CreateOptions,
  ExecOptions,
  FilePutOptions,
  RunOptions,
  RunResult,
  SessionHandle,
} from "./types.js";

export { DEFAULT_RUNTIME, SUPPORTED_RUNTIMES };

/** The slice of {@link SandboxClient} a one-shot run needs. */
export interface RunClient {
  createSession(opts?: CreateOptions): Promise<SessionHandle>;
  waitForReady(handle: SessionHandle, timeoutMs?: number): Promise<unknown>;
  putFile(handle: SessionHandle, opts: FilePutOptions): Promise<FilePutResult | OperationError>;
  exec(handle: SessionHandle, opts: ExecOptions): Promise<ExecResult | OperationError>;
  getFile(
    handle: SessionHandle,
    path: string,
    archive?: boolean,
    queueMs?: number,
  ): Promise<FileGetResult | OperationError>;
  destroy(handle: SessionHandle, waitMs?: number): Promise<unknown>;
}

/**
 * Reject a runtime the product does not ship before any session is created.
 * The list is the shared contract, not a client-side freeze; the server also
 * returns a 400 for an unknown name, so an older SDK still fails safely.
 */
export function assertSupportedRuntime(runtime: string | undefined): string {
  const name = runtime ?? DEFAULT_RUNTIME;
  if (!isSupportedRuntime(name)) {
    throw new SandboxError(
      "unsupported_runtime",
      `runtime "${name}" is not available; supported runtimes: ${SUPPORTED_RUNTIMES.join(", ")}`,
    );
  }
  return name;
}

export async function runOnce(client: RunClient, opts: RunOptions): Promise<RunResult> {
  const runtime = assertSupportedRuntime(opts.runtime);
  if (!opts.command || opts.command.length === 0) {
    throw new SandboxError("invalid_command", "run requires a command");
  }
  const {
    runtime: _requestedRuntime,
    command,
    files,
    returnFiles,
    env,
    cwd,
    timeoutMs,
    ...createOptions
  } = opts;

  const handle = await client.createSession({ ...createOptions, runtime });
  let primaryError: unknown;
  try {
    await client.waitForReady(handle);

    for (const [path, data] of Object.entries(files ?? {})) {
      const result = await client.putFile(handle, {
        path: workspacePath(path),
        data: typeof data === "string" ? Buffer.from(data) : data,
      });
      if (!result.ok) throw operationError("upload_failed", path, result);
    }

    const execResult = await client.exec(handle, {
      command,
      ...(env ? { env } : {}),
      ...(cwd ? { cwd } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    if (!execResult.ok) throw operationError("exec_failed", command[0] ?? "", execResult);

    const outputs: Record<string, Uint8Array> = {};
    for (const path of returnFiles ?? []) {
      const result = await client.getFile(handle, workspacePath(path));
      if (!result.ok) throw operationError("download_failed", path, result);
      outputs[path] = Buffer.from(result.dataBase64, "base64");
    }

    return {
      sessionId: handle.sessionId,
      exitCode: execResult.exitCode,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      files: outputs,
      durationMs: execResult.durationMs,
      timedOut: execResult.timedOut,
      cancelled: execResult.cancelled,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    try {
      await client.destroy(handle);
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError !== undefined) {
      // A failed cleanup is never silent. If the run itself failed, keep the
      // primary error and attach the cleanup failure instead of masking it.
      if (primaryError === undefined) throw cleanupError;
      attachCleanupError(primaryError, cleanupError, handle.sessionId);
    }
  }
}

function workspacePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "") {
    throw new SandboxError("invalid_path", "workspace path must not be empty");
  }
  if (trimmed.startsWith("/")) {
    if (trimmed === "/workspace" || trimmed.startsWith("/workspace/")) return trimmed;
    throw new SandboxError("invalid_path", `path is outside the workspace: ${path}`);
  }
  if (trimmed.split("/").includes("..")) {
    throw new SandboxError("invalid_path", `path escapes the workspace: ${path}`);
  }
  return trimmed;
}

function operationError(fallback: string, path: string, result: OperationError): SandboxError {
  const code = result.error?.code ?? fallback;
  const detail = result.error?.message ?? fallback;
  return new SandboxError(code, `${fallback} (${path}): ${detail}`, undefined, result.requestId);
}

function attachCleanupError(primary: unknown, cleanup: unknown, sessionId: string): void {
  if (typeof primary !== "object" || primary === null) return;
  const target = primary as { cleanupError?: unknown; cause?: unknown; message?: unknown };
  if (target.cleanupError === undefined) target.cleanupError = cleanup;
  if (target.cause === undefined) target.cause = cleanup;
  if (typeof target.message === "string" && !target.message.includes("cleanup also failed")) {
    target.message += ` (cleanup also failed; session ${sessionId} may still be live)`;
  }
}
