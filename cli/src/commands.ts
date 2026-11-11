/**
 * Command handlers for the `sandbox` CLI. The registry is keyed by command name;
 * `index.ts` parses arguments and dispatches.
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile, stat, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import {
  SandboxClient,
  type CreateOptions,
  type SessionHandle,
  type SessionTier,
} from "@x402s/sdk";

export const HELP = `x402 sandbox sessions

Usage:
  sandbox create [--tier short|standard|extended|long] [--runtime base|python|node]
                 [--duration 15m]
                 [--cpu 1] [--memory 1Gi] [--disk 1Gi]
                 [--baseline-cpu 0.25] [--baseline-memory 256Mi]
                 [--idle 5m] [--max-lifetime 8h]
  sandbox exec <session-id> [--timeout 30s] [--env K=V] -- <command> [args...]
  sandbox upload <session-id> <local-path> <remote-path>
  sandbox download <session-id> <remote-path> <local-path> [--extract]
  sandbox ls <session-id> [path] [--recursive]
  sandbox stat <session-id> <path>
  sandbox status <session-id>
  sandbox suspend <session-id>
  sandbox resume <session-id>
  sandbox serve <session-id> --name web --port 8080 -- python3 -m http.server 8080
  sandbox services <session-id>
  sandbox stop-service <session-id> <name>
  sandbox http <session-id> <port> <path> [--method GET] [--body text] [--stream]
  sandbox destroy <session-id>
  sandbox run [create options] [--runtime base|python|node] [--file local=remote]
              [--return remote] -- <command> [args...]
                                # one-shot: create, upload, exec, download, destroy
  sandbox run <file> [create options]   # legacy: run a local .py/.js/.sh file
  sandbox agent-demo <file>     # same, purchased through @x402/fetch
  sandbox pricing
  sandbox sessions              # locally stored session handles
  sandbox admin capacity        # inspect controller capacity/reservations

Common options:
  --api-url <url>               default http://localhost:8080
  --payment-mode mock|testnet   default mock
  --json                        machine-readable output
  --quiet                       suppress progress notes
  -h, --help
`;

function parseDuration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const m = /^(\d+)(s|m|h)?$/.exec(value.trim());
  if (!m) throw new Error(`invalid duration: ${value}`);
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  return unit === "h" ? n * 3600 : unit === "m" ? n * 60 : n;
}

function parseMemory(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const m = /^(\d+)(Mi|Gi)?$/.exec(value.trim());
  if (!m) throw new Error(`invalid memory: ${value}`);
  const n = Number(m[1]);
  return m[2] === "Gi" ? n * 1024 : n;
}

function parseCpu(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid cpu: ${value}`);
  return Math.round(n * 1000);
}

function parseDisk(value: string | undefined): number | undefined {
  return parseMemory(value);
}

const TIER_BY_DURATION: Record<number, SessionTier> = { 60: "short", 300: "standard", 900: "extended", 1800: "long" };

function inferTier(explicit: string | undefined, durationSeconds: number | undefined): SessionTier | undefined {
  if (explicit) return explicit as SessionTier;
  if (durationSeconds !== undefined) return TIER_BY_DURATION[durationSeconds] ?? "custom";
  return undefined;
}

function parseCreateOptions(values: CommandContext["values"]): CreateOptions {
  const durationSeconds = parseDuration(values.duration as string | undefined);
  const tier = inferTier(values.tier as string | undefined, durationSeconds);
  return {
    ...(tier ? { tier } : {}),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(values.cpu ? { cpuMillis: parseCpu(values.cpu as string) } : {}),
    ...(values.memory ? { memoryMiB: parseMemory(values.memory as string) } : {}),
    ...(values.disk ? { diskMiB: parseDisk(values.disk as string) } : {}),
    ...(values["baseline-cpu"]
      ? { baselineCpuMillis: parseCpu(values["baseline-cpu"] as string) }
      : {}),
    ...(values["baseline-memory"]
      ? { baselineMemoryMiB: parseMemory(values["baseline-memory"] as string) }
      : {}),
    ...(values.idle
      ? {
          idlePolicy: {
            maxIdleSeconds: parseDuration(values.idle as string) ?? 300,
            suspendedDurationSeconds: 28800,
            autoResume: false,
          },
        }
      : {}),
    ...(values["max-lifetime"]
      ? { maxLifetimeSeconds: parseDuration(values["max-lifetime"] as string) }
      : {}),
    ...(values.runtime === undefined ? {} : { runtime: String(values.runtime) }),
  };
}

function out(line: string, json: boolean): void {
  if (!json) process.stdout.write(line + "\n");
}

export function err(line: string, quiet: boolean): void {
  if (!quiet) process.stderr.write(line + "\n");
}

async function tarDirectory(path: string): Promise<Buffer> {
  const parent = dirname(resolvePath(path));
  const base = basename(resolvePath(path));
  return execFileSync("tar", ["-czf", "-", "-C", parent, base], { maxBuffer: 64 * 1024 * 1024 });
}

async function extractTar(data: Buffer, destination: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "x402-extract-"));
  const tarPath = join(dir, "archive.tar.gz");
  await writeFile(tarPath, data);
  const listing = execFileSync("tar", ["-tzf", tarPath], { encoding: "utf8" });
  for (const member of listing.split("\n").filter(Boolean)) {
    if (member.startsWith("/") || member.split("/").includes("..")) {
      throw new Error(`unsafe archive member: ${member}`);
    }
  }
  execFileSync("tar", ["-xzf", tarPath, "-C", destination]);
}

export type CommandContext = {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
  apiUrl: string;
  json: boolean;
  quiet: boolean;
  paymentMode: "mock" | "testnet";
  client: SandboxClient;
  attach: (id: string) => SessionHandle;
  /** True when argv contained `--`, which marks the one-shot run form. */
  hasSeparator: boolean;
};

export const commands: Record<string, (ctx: CommandContext) => Promise<number>> = {
  "create": async (ctx) => {
    const { values, json, client, paymentMode } = ctx;
      const handle = await client.createSession(parseCreateOptions(values));
      out(`Session: ${handle.sessionId}`, json);
      out(`State: ${handle.status?.state ?? "PAID"}`, json);
      if (handle.status) {
        out(
          `Tier: ${handle.status.tier} (${handle.status.durationSeconds}s, ${handle.status.limits.cpuMillis}m CPU, ` +
            `${handle.status.limits.memoryMiB}Mi RAM, ${handle.status.limits.diskMiB}Mi disk)`,
          json,
        );
      }
      out(`Price: ${handle.status?.payment.priceUsd ?? "?"} (${paymentMode} payment)`, json);

      if (!values["no-wait"]) {
        const status = await client.waitForReady(handle);
        out(`Evidence: ${status.attestation?.evidenceType ?? "none"} (session key binding, no hardware root of trust)`, json);
        out(`State: ${status.state}`, json);
        out(`Expires: ${status.leaseExpiresAt ?? "?"} (${status.remainingSeconds}s remaining)`, json);
      }
      if (json) process.stdout.write(JSON.stringify({ sessionId: handle.sessionId, status: handle.status }, null, 2) + "\n");
      return 0;
  },
  "status": async (ctx) => {
    const { positionals, json, client, attach } = ctx;
      const id = requireArg(positionals[1], "session id");
      const status = await client.status(attach(id));
      if (json) {
        process.stdout.write(JSON.stringify(status, null, 2) + "\n");
      } else {
        process.stdout.write(`Session: ${status.sessionId}\n`);
        process.stdout.write(`State: ${status.state}\n`);
        process.stdout.write(`Tier: ${status.tier} (${status.durationSeconds}s)\n`);
        process.stdout.write(
          `Limits: ${status.limits.cpuMillis}m CPU, ${status.limits.memoryMiB}Mi RAM, ${status.limits.diskMiB}Mi disk\n`,
        );
        process.stdout.write(`Created: ${status.createdAt}\n`);
        if (status.readyAt) process.stdout.write(`Ready: ${status.readyAt}\n`);
        if (status.leaseExpiresAt) {
          process.stdout.write(`Expires: ${status.leaseExpiresAt} (${status.remainingSeconds}s remaining)\n`);
        }
        if (status.baseline) {
          process.stdout.write(`Baseline: ${status.baseline.cpuMillis}m CPU, ${status.baseline.memoryMiB}Mi RAM\n`);
        }
        if (status.idlePolicy) {
          process.stdout.write(`Idle policy: maxIdle ${status.idlePolicy.maxIdleSeconds}s, autoResume ${status.idlePolicy.autoResume}\n`);
        }
        if (status.suspendedAt) process.stdout.write(`Suspended: ${status.suspendedAt}\n`);
        if (status.resumeCount) process.stdout.write(`Resumes: ${status.resumeCount}\n`);
        if (status.failure) process.stdout.write(`Failure: ${status.failure.code}: ${status.failure.message}\n`);
        process.stdout.write(`Busy: ${status.busy}\n`);
      }
      return 0;
  },
  "exec": async (ctx) => {
    const { values, positionals, json, quiet, client, attach } = ctx;
      const id = requireArg(positionals[1], "session id");
      const commandArgs = positionals.slice(2);
      if (commandArgs.length === 0) {
        process.stderr.write("missing command; use: sandbox exec <id> -- <command> [args...]\n");
        return 2;
      }
      const handle = attach(id);
      const envFromArgs = parseEnv(values.env as string[] | undefined);
      const result = await client.exec(handle, {
        command: commandArgs,
        ...(envFromArgs ? { env: envFromArgs } : {}),
        ...(values.timeout ? { timeoutMs: parseDuration(values.timeout as string)! * 1000 } : {}),
      });
      if (!result.ok) {
        process.stderr.write(`error: ${result.error?.code}: ${result.error?.message}\n`);
        return 1;
      }
      if (json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        if (result.stdout) process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : result.stdout + "\n");
        if (result.stderr) process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : result.stderr + "\n");
        err(
          `exit ${result.exitCode} (${result.durationMs}ms${result.timedOut ? ", timed out" : ""}${result.cancelled ? ", cancelled" : ""})`,
          quiet,
        );
      }
      return result.timedOut ? 124 : Math.max(0, Math.min(125, result.exitCode));
  },
  "upload": async (ctx) => {
    const { positionals, json, client, attach } = ctx;
      const id = requireArg(positionals[1], "session id");
      const local = requireArg(positionals[2], "local path");
      const remote = requireArg(positionals[3], "remote path");
      const info = await stat(local);
      const handle = attach(id);
      let data: Buffer;
      let archive = false;
      if (info.isDirectory()) {
        data = await tarDirectory(local);
        archive = true;
      } else {
        data = await readFile(local);
      }
      const result = await client.putFile(handle, { path: remote, data, archive });
      if (!result.ok) {
        process.stderr.write(`error: ${result.error?.code}: ${result.error?.message}\n`);
        return 1;
      }
      out(`Uploaded ${result.filesWritten} file(s), ${result.bytesWritten} bytes to ${result.path}`, json);
      return 0;
  },
  "download": async (ctx) => {
    const { values, positionals, json, client, attach } = ctx;
      const id = requireArg(positionals[1], "session id");
      const remote = requireArg(positionals[2], "remote path");
      const local = requireArg(positionals[3], "local path");
      const handle = attach(id);
      const result = await client.getFile(handle, remote, Boolean(values.archive) || Boolean(values.extract));
      if (!result.ok) {
        process.stderr.write(`error: ${result.error?.code}: ${result.error?.message}\n`);
        return 1;
      }
      const data = Buffer.from(result.dataBase64, "base64");
      if (values.extract) {
        await extractTar(data, local);
        out(`Extracted ${data.length} bytes into ${local}`, json);
      } else {
        await writeFile(local, data);
        out(`Downloaded ${data.length} bytes to ${local}`, json);
      }
      return 0;
  },
  "ls": async (ctx) => {
    const { values, positionals, json, client, attach } = ctx;
      const id = requireArg(positionals[1], "session id");
      const path = positionals[2] ?? ".";
      const handle = attach(id);
      const result = await client.listFiles(handle, path, Boolean(values.recursive));
      if (!result.ok) {
        process.stderr.write(`error: ${result.error?.code}: ${result.error?.message}\n`);
        return 1;
      }
      if (json) {
        process.stdout.write(JSON.stringify(result.entries, null, 2) + "\n");
      } else {
        for (const entry of result.entries) {
          process.stdout.write(`${entry.isDir ? "d" : "-"} ${String(entry.size).padStart(10)}  ${entry.path}\n`);
        }
        out(`${result.entries.length} entries, ${result.totalBytes} bytes`, json);
      }
      return 0;
  },
  "stat": async (ctx) => {
    const { positionals, client, attach } = ctx;
      const id = requireArg(positionals[1], "session id");
      const path = requireArg(positionals[2], "path");
      const result = await client.statFile(attach(id), path);
      if (!result.ok) {
        process.stderr.write(`error: ${result.error?.code}: ${result.error?.message}\n`);
        return 1;
      }
      process.stdout.write(JSON.stringify(result.entry, null, 2) + "\n");
      return 0;
  },
  "suspend": async (ctx) => {
    const { positionals, json, client, attach } = ctx;
      const id = requireArg(positionals[1], "session id");
      const status = await client.suspend(attach(id));
      out(`State: ${status.state}`, json);
      if (json) process.stdout.write(JSON.stringify(status, null, 2) + "\n");
      return 0;
  },
  "resume": async (ctx) => {
    const { positionals, json, client, attach } = ctx;
      const id = requireArg(positionals[1], "session id");
      const status = await client.resume(attach(id));
      out(`State: ${status.state}`, json);
      if (json) process.stdout.write(JSON.stringify(status, null, 2) + "\n");
      return 0;
  },
  "serve": async (ctx) => {
    const { values, positionals, json, client, attach } = ctx;
      const id = requireArg(positionals[1], "session id");
      const command = positionals.slice(2);
      if (command.length === 0) {
        process.stderr.write("error: serve requires -- <command> [args...]\n");
        return 2;
      }
      const name = String(values.name ?? "web");
      const port = Number(values.port ?? 8080);
      const info = await client.startService(attach(id), { name, command, port });
      out(`Service: ${info.name} on 127.0.0.1:${info.port} (pid ${info.pid}, ${info.state})`, json);
      if (json) process.stdout.write(JSON.stringify(info, null, 2) + "\n");
      return 0;
  },
  "services": async (ctx) => {
    const { positionals, json, client, attach } = ctx;
      const id = requireArg(positionals[1], "session id");
      const services = await client.listServices(attach(id));
      if (json) {
        process.stdout.write(JSON.stringify(services, null, 2) + "\n");
      } else if (services.length === 0) {
        out("No services", json);
      } else {
        for (const service of services) {
          process.stdout.write(
            `${service.name}\t${service.state}\t127.0.0.1:${service.port}\tpid ${service.pid}\n`,
          );
        }
      }
      return 0;
  },
  "stop-service": async (ctx) => {
    const { positionals, json, client, attach } = ctx;
      const id = requireArg(positionals[1], "session id");
      const name = requireArg(positionals[2], "service name");
      await client.stopService(attach(id), name);
      out(`Service ${name}: stopped`, json);
      return 0;
  },
  "http": async (ctx) => {
    const { values, positionals, json, client, attach } = ctx;
      const id = requireArg(positionals[1], "session id");
      const port = Number(requireArg(positionals[2], "port"));
      const path = positionals[3] ?? "/";
      const handle = attach(id);
      const request = {
        port,
        path,
        method: String(values.method ?? "GET"),
        ...(values.body !== undefined ? { body: String(values.body) } : {}),
      };
      if (values.stream) {
        const stream = await client.openHttpStream(handle, request);
        let done = false;
        while (!done) {
          const part = await stream.read();
          if (part.chunk) process.stdout.write(part.chunk);
          done = part.done;
        }
        await stream.close();
        return 0;
      }
      const response = await client.http(handle, request);
      if (json) {
        process.stdout.write(
          JSON.stringify(
            { status: response.status, headers: response.headers, body: response.body.toString("base64"), truncated: response.truncated },
            null,
            2,
          ) + "\n",
        );
      } else {
        out(`HTTP ${response.status}`, json);
        process.stdout.write(response.body);
        if (response.truncated) process.stderr.write("\n[response truncated]\n");
      }
      return 0;
  },
  "destroy": async (ctx) => {
    const { positionals, json, client, attach } = ctx;
      const id = requireArg(positionals[1], "session id");
      const handle = attach(id);
      const status = await client.destroy(handle);
      out(status ? `Sandbox: ${status.state.toLowerCase()}` : "Sandbox: destroyed", json);
      if (json) process.stdout.write(JSON.stringify({ sessionId: id, state: status?.state ?? "DESTROYED" }, null, 2) + "\n");
      return 0;
  },
  "run": async (ctx) => {
    const { values, positionals, json, quiet, client, hasSeparator } = ctx;
      const oneShot =
        hasSeparator ||
        values.runtime !== undefined ||
        values.file !== undefined ||
        values.return !== undefined;
      if (oneShot) return runOneShot(ctx);

      const file = requireArg(positionals[1], "file");
      const durationSeconds = parseDuration(values.duration as string | undefined) ?? 300;
      const tier = inferTier(values.tier as string | undefined, durationSeconds);
      return runFile(client, file, {
        json,
        quiet,
        keep: Boolean(values.keep),
        create: {
          ...(tier ? { tier } : {}),
          ...(durationSeconds === undefined ? {} : { durationSeconds }),
        },
      });
  },
  "agent-demo": async (ctx) => {
    const { values, positionals, json, quiet, client } = ctx;
      const file = requireArg(positionals[1], "file");
      const durationSeconds = parseDuration(values.duration as string | undefined) ?? 300;
      const tier = inferTier(values.tier as string | undefined, durationSeconds);
      return runFile(client, file, {
        json,
        quiet,
        keep: Boolean(values.keep),
        create: {
          ...(tier ? { tier } : {}),
          ...(durationSeconds === undefined ? {} : { durationSeconds }),
        },
      });
  },
};


function parseEnv(values: string[] | undefined): Record<string, string> | undefined {
  if (!values || values.length === 0) return undefined;
  const env: Record<string, string> = {};
  for (const entry of values) {
    const idx = entry.indexOf("=");
    if (idx <= 0) throw new Error(`invalid --env ${entry} (expected KEY=VALUE)`);
    env[entry.slice(0, idx)] = entry.slice(idx + 1);
  }
  return env;
}

function requireArg(value: string | undefined, label: string): string {
  if (!value) throw new Error(`missing ${label}`);
  return value;
}

function interpreterFor(file: string): string[] {
  if (file.endsWith(".py")) return ["python3"];
  if (file.endsWith(".js") || file.endsWith(".mjs")) return ["node"];
  if (file.endsWith(".sh")) return ["bash"];
  throw new Error(`don't know how to run ${file} (expected .py, .js, .mjs or .sh)`);
}

async function runFile(
  client: SandboxClient,
  file: string,
  opts: { json: boolean; quiet: boolean; keep: boolean; create: Record<string, unknown> },
): Promise<number> {
  const code = await readFile(file);
  const remote = `/workspace/${basename(file)}`;
  const handle = await client.createSession(opts.create);
  try {
    const status = await client.waitForReady(handle);
    out(`Session: ${handle.sessionId}`, opts.json);
    out(`Evidence: ${status.attestation?.evidenceType ?? "none"} (session key binding, no hardware root of trust)`, opts.json);
    const put = await client.putFile(handle, { path: remote, data: code });
    if (!put.ok) {
      process.stderr.write(`upload failed: ${put.error?.code}: ${put.error?.message}\n`);
      return 1;
    }
    const result = await client.exec(handle, {
      command: [...interpreterFor(file), remote],
      timeoutMs: Math.min(status.remainingSeconds * 1000, 120_000),
    });
    if (!result.ok) {
      process.stderr.write(`execution failed: ${result.error?.code}: ${result.error?.message}\n`);
      return 1;
    }
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      if (result.stdout) process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : result.stdout + "\n");
      if (result.stderr) process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : result.stderr + "\n");
      process.stdout.write(`\nExit code: ${result.exitCode}\n`);
      process.stdout.write(`Execution: ${(result.durationMs / 1000).toFixed(1)}s\n`);
    }
    return result.timedOut ? 124 : Math.max(0, Math.min(125, result.exitCode));
  } finally {
    if (!opts.keep) {
      const destroyed = await client.destroy(handle).catch(() => null);
      out(`Sandbox: ${(destroyed?.state ?? "DESTROYED").toLowerCase()}`, opts.json);
    }
  }
}

async function runOneShot(ctx: CommandContext): Promise<number> {
  const { values, positionals, json, quiet, client } = ctx;
  const command = positionals.slice(1);
  if (command.length === 0) {
    process.stderr.write("missing command; use: sandbox run [options] -- <command> [args...]\n");
    return 2;
  }

  const files: Record<string, Uint8Array> = {};
  for (const spec of (values.file as string[] | undefined) ?? []) {
    const idx = spec.indexOf("=");
    if (idx <= 0 || idx === spec.length - 1) {
      process.stderr.write(`invalid --file ${spec} (expected local=remote)\n`);
      return 2;
    }
    files[spec.slice(idx + 1)] = await readFile(spec.slice(0, idx));
  }
  const returnFiles = (values.return as string[] | undefined) ?? [];
  const env = parseEnv(values.env as string[] | undefined);
  const timeoutSeconds = values.timeout ? parseDuration(values.timeout as string) : undefined;

  const result = await client.run({
    ...parseCreateOptions(values),
    command,
    ...(Object.keys(files).length === 0 ? {} : { files }),
    ...(returnFiles.length === 0 ? {} : { returnFiles }),
    ...(env ? { env } : {}),
    ...(timeoutSeconds === undefined ? {} : { timeoutMs: timeoutSeconds * 1000 }),
  });

  const written: Record<string, string> = {};
  for (const [remote, data] of Object.entries(result.files)) {
    const local = localReturnPath(remote);
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, data);
    written[remote] = local;
  }

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          sessionId: result.sessionId,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          files: Object.fromEntries(
            Object.entries(result.files).map(([path, data]) => [path, Buffer.from(data).toString("base64")]),
          ),
          written,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    if (result.stdout) process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : result.stdout + "\n");
    if (result.stderr) process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : result.stderr + "\n");
    for (const [remote, local] of Object.entries(written)) err(`Wrote ${remote} -> ${local}`, quiet);
    err(
      `exit ${result.exitCode} (${result.durationMs}ms${result.timedOut ? ", timed out" : ""}` +
        `${result.cancelled ? ", cancelled" : ""})`,
      quiet,
    );
  }
  return result.timedOut ? 124 : Math.max(0, Math.min(125, result.exitCode));
}

function localReturnPath(remote: string): string {
  const prefix = "/workspace/";
  const path = remote.startsWith(prefix) ? remote.slice(prefix.length) : remote;
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`invalid --return path: ${remote}`);
  }
  return path;
}
