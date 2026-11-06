#!/usr/bin/env node
/**
 * `sandbox` CLI — a thin shell around @x402s/sdk.
 *
 *   sandbox create --tier standard
 *   sandbox exec <id> -- bash -c "echo hi > /workspace/hi.txt"
 *   sandbox upload <id> ./file.py /workspace/file.py
 *   sandbox download <id> /workspace/out.txt ./out.txt
 *   sandbox ls <id> /workspace
 *   sandbox destroy <id>
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile, stat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import {
  SandboxClient,
  SandboxError,
  SessionExpiredError,
  FileSessionStore,
  type SessionHandle,
  type SessionTier,
} from "@x402s/sdk";
import { createAgentPayer } from "./agent-payer.js";

const HELP = `x402 sandbox sessions

Usage:
  sandbox create [--tier short|standard|extended|long] [--duration 15m]
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
  sandbox destroy <session-id>
  sandbox run <file>            # create + upload + exec + destroy (convenience)
  sandbox agent-demo <file>     # same, purchased through @x402/fetch
  sandbox pricing
  sandbox sessions              # locally stored session handles

Common options:
  --api-url <url>               default http://localhost:8080
  --payment-mode mock|testnet   default mock
  --allow-insecure-dev          required to accept simulated attestation
  --require-hardware            reject non-hardware-attested execution
  --expected-measurement <hex>  pin the guest measurement
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

function out(line: string, json: boolean): void {
  if (!json) process.stdout.write(line + "\n");
}

function err(line: string, quiet: boolean): void {
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
  execFileSync("tar", ["-xzf", tarPath, "-C", destination]);
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "api-url": { type: "string", default: "http://localhost:8080" },
      "payment-mode": { type: "string", default: "mock" },
      "allow-insecure-dev": { type: "boolean", default: false },
      "require-hardware": { type: "boolean", default: false },
      "expected-measurement": { type: "string" },
      tier: { type: "string" },
      duration: { type: "string" },
      cpu: { type: "string" },
      memory: { type: "string" },
      disk: { type: "string" },
      "baseline-cpu": { type: "string" },
      "baseline-memory": { type: "string" },
      idle: { type: "string" },
      "max-lifetime": { type: "string" },
      timeout: { type: "string" },
      env: { type: "string", multiple: true },
      recursive: { type: "boolean", default: false },
      extract: { type: "boolean", default: false },
      archive: { type: "boolean", default: false },
      "no-wait": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const command = positionals[0] ?? "help";
  const json = Boolean(values.json);
  const quiet = Boolean(values.quiet);
  const apiUrl = String(values["api-url"]);
  const allowInsecureDev = Boolean(values["allow-insecure-dev"]);
  const requireHardware = Boolean(values["require-hardware"]);

  if (values.help || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "version") {
    process.stdout.write("sandbox 0.2.0\n");
    return 0;
  }

  if (command === "pricing") {
    const res = await fetch(`${apiUrl}/v1/pricing`);
    process.stdout.write(JSON.stringify(await res.json(), null, 2) + "\n");
    return res.ok ? 0 : 1;
  }

  if (command === "sessions") {
    const store = new FileSessionStore();
    const rows = store.list();
    if (json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    } else if (rows.length === 0) {
      process.stdout.write("no locally stored sessions\n");
    } else {
      for (const row of rows) {
        process.stdout.write(
          `${row.sessionId}  ${row.tier ?? "?"}  created ${new Date(row.createdAt).toISOString()}  ${row.apiUrl}\n`,
        );
      }
    }
    return 0;
  }

  if (!allowInsecureDev && !requireHardware) {
    process.stderr.write(
      "refusing to run: simulated attestation requires --allow-insecure-dev\n" +
        "(or pass --require-hardware to demand SEV-SNP/TDX evidence, which this deployment does not provide)\n",
    );
    return 2;
  }

  const paymentMode = String(values["payment-mode"]);
  if (paymentMode !== "mock" && paymentMode !== "testnet") {
    process.stderr.write(`invalid --payment-mode: ${paymentMode}\n`);
    return 2;
  }

  const agent = command === "agent-demo";
  const client = new SandboxClient({
    apiUrl,
    paymentMode,
    allowInsecureDev,
    requireHardware,
    ...(values["expected-measurement"] ? { expectedMeasurement: String(values["expected-measurement"]) } : {}),
    ...(agent
      ? { payer: await createAgentPayer(paymentMode, apiUrl, (l) => err(l, quiet)) }
      : {}),
    store: new FileSessionStore(),
    log: (l) => err(l, quiet),
  });

  const attach = (id: string): SessionHandle => client.attach(id);

  switch (command) {
    case "create": {
      const durationSeconds = parseDuration(values.duration as string | undefined);
      const tier = inferTier(values.tier as string | undefined, durationSeconds);
      const handle = await client.createSession({
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
      });
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
        out(`Attestation: ${status.attestation?.insecureDevOnly ? "INSECURE_DEV_ONLY" : "HARDWARE-VERIFIED"} (${status.attestation?.evidenceType})`, json);
        out(`State: ${status.state}`, json);
        out(`Expires: ${status.leaseExpiresAt ?? "?"} (${status.remainingSeconds}s remaining)`, json);
      }
      if (json) process.stdout.write(JSON.stringify({ sessionId: handle.sessionId, status: handle.status }, null, 2) + "\n");
      return 0;
    }

    case "status": {
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
    }

    case "exec": {
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
    }

    case "upload": {
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
    }

    case "download": {
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
    }

    case "ls": {
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
    }

    case "stat": {
      const id = requireArg(positionals[1], "session id");
      const path = requireArg(positionals[2], "path");
      const result = await client.statFile(attach(id), path);
      if (!result.ok) {
        process.stderr.write(`error: ${result.error?.code}: ${result.error?.message}\n`);
        return 1;
      }
      process.stdout.write(JSON.stringify(result.entry, null, 2) + "\n");
      return 0;
    }

    case "suspend": {
      const id = requireArg(positionals[1], "session id");
      const status = await client.suspend(attach(id));
      out(`State: ${status.state}`, json);
      if (json) process.stdout.write(JSON.stringify(status, null, 2) + "\n");
      return 0;
    }

    case "resume": {
      const id = requireArg(positionals[1], "session id");
      const status = await client.resume(attach(id));
      out(`State: ${status.state}`, json);
      if (json) process.stdout.write(JSON.stringify(status, null, 2) + "\n");
      return 0;
    }

    case "destroy": {
      const id = requireArg(positionals[1], "session id");
      const handle = attach(id);
      const status = await client.destroy(handle);
      out(status ? `Sandbox: ${status.state.toLowerCase()}` : "Sandbox: destroyed", json);
      if (json) process.stdout.write(JSON.stringify({ sessionId: id, state: status?.state ?? "DESTROYED" }, null, 2) + "\n");
      return 0;
    }

    case "run":
    case "agent-demo": {
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
    }

    default:
      process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

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
    out(`Attestation: ${status.attestation?.insecureDevOnly ? "INSECURE_DEV_ONLY" : "HARDWARE-VERIFIED"} (${status.attestation?.evidenceType})`, opts.json);
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

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof SessionExpiredError) {
      process.stderr.write(`error: ${error.message}\n`);
      process.exit(124);
    }
    if (error instanceof SandboxError) {
      process.stderr.write(`error: ${error.code}: ${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`fatal: ${(error as Error).message}\n`);
    process.exit(1);
  });
