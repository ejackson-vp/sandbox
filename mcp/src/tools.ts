/**
 * The two tools: check the price, then run one command.
 *
 * Two, not ten, because every tool is a sentence an agent has to choose between
 * before it spends money. `pricing` costs nothing and answers "what will this
 * cost me", which is the question a spending agent should ask first; `run`
 * buys one session, executes, returns the output and destroys the box. There is
 * deliberately no tool that leaves a session behind: the lease is the product,
 * and an agent that could keep one alive would be buying something else.
 */
import type { RunResult, SandboxClient } from "@x402s/sdk";
import type { McpConfig } from "./config.js";

/** A file written into `/workspace` before the command runs. */
export interface WorkspaceFile {
  path: string;
  content: string;
}

export interface RunInput {
  command: string;
  files?: WorkspaceFile[];
  tier?: McpConfig["defaultTier"];
  runtime?: "base" | "python" | "node";
  timeoutSeconds?: number;
}

/** What a caller needs to see, and nothing about the wallet that paid. */
export function renderRun(result: RunResult): string {
  const lines = [
    `exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}${
      result.cancelled ? " (cancelled)" : ""
    }`,
    `${result.durationMs} ms, session ${result.sessionId}`,
  ];
  if (result.stdout) lines.push("", "stdout:", result.stdout.trimEnd());
  if (result.stderr) lines.push("", "stderr:", result.stderr.trimEnd());
  if (Object.keys(result.files).length > 0) {
    lines.push("", "files:", ...Object.keys(result.files).map((path) => `  ${path}`));
  }
  return lines.join("\n");
}

/**
 * Reject a path the guest would have to write outside its workspace.
 *
 * The SDK already treats keys as workspace-relative, but a path that escapes is
 * a mistake worth naming before a session is paid for rather than an error from
 * the guest afterwards.
 */
function assertRelative(path: string): void {
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`files[].path must be workspace-relative, got ${path}`);
  }
}

/** Turn the tool's file list into the map the SDK expects. */
export function workspaceFiles(files: WorkspaceFile[] | undefined): Record<string, string> {
  if (!files || files.length === 0) return {};
  const out: Record<string, string> = {};
  for (const file of files) {
    assertRelative(file.path);
    out[file.path] = file.content;
  }
  return out;
}

/**
 * The one-shot command, wrapped so a model can pass a shell line.
 *
 * `run` takes argv, not a shell string, because quoting is the caller's job in
 * every other interface. A model writing `python3 -c "..."` would have to know
 * how the server splits it, so the split is done once, here, by the shell the
 * guest ships.
 */
export function commandArgv(command: string): string[] {
  const trimmed = command.trim();
  if (trimmed.length === 0) throw new Error("command must not be empty");
  return ["/bin/sh", "-lc", trimmed];
}

/** Execute one command in a fresh box, and always destroy it. */
export async function runOne(
  client: Pick<SandboxClient, "run">,
  config: McpConfig,
  input: RunInput,
): Promise<RunResult> {
  const timeoutSeconds = input.timeoutSeconds ?? config.maxCommandSeconds;
  return client.run({
    command: commandArgv(input.command),
    files: workspaceFiles(input.files),
    tier: input.tier ?? config.defaultTier,
    ...(input.runtime ? { runtime: input.runtime } : {}),
    timeoutMs: Math.max(1_000, Math.min(timeoutSeconds, config.maxCommandSeconds) * 1_000),
  });
}

/** The live price table, read from the service rather than restated here. */
export async function readPricing(apiUrl: string): Promise<unknown> {
  const response = await fetch(`${apiUrl}/v1/pricing`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`pricing answered ${response.status}`);
  return response.json();
}
