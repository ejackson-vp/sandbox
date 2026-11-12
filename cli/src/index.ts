#!/usr/bin/env node
/**
 * `sandbox` CLI — argument parsing, early commands, and dispatch.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  SandboxClient,
  SandboxError,
  SessionExpiredError,
  FileSessionStore,
  type SessionHandle,
} from "@x402s/sdk";
import { createAgentPayer } from "./agent-payer.js";
import { commands, err, HELP, type CommandContext } from "./commands.js";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "api-url": { type: "string", default: "http://localhost:8080" },
      "payment-mode": { type: "string", default: "mock" },
      tier: { type: "string" },
      duration: { type: "string" },
      cpu: { type: "string" },
      memory: { type: "string" },
      disk: { type: "string" },
      "baseline-cpu": { type: "string" },
      "baseline-memory": { type: "string" },
      idle: { type: "string" },
      name: { type: "string" },
      port: { type: "string" },
      method: { type: "string" },
      body: { type: "string" },
      stream: { type: "boolean", default: false },
      "max-lifetime": { type: "string" },
      timeout: { type: "string" },
      env: { type: "string", multiple: true },
      file: { type: "string", multiple: true },
      return: { type: "string", multiple: true },
      runtime: { type: "string" },
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

  if (values.help || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "version") {
    process.stdout.write("sandbox 0.2.0\n");
    return 0;
  }

  if (command === "admin") {
    if (positionals[1] !== "capacity") {
      process.stderr.write("usage: sandbox admin capacity\n");
      return 2;
    }
    const controllerUrl = process.env.CONTROLLER_URL ?? "http://localhost:3001";
    const token = process.env.CONTROLLER_ADMIN_TOKEN ?? process.env.ADMIN_TOKEN ?? "";
    const res = await fetch(new URL("/internal/capacity", controllerUrl), {
      headers: { "x-internal-token": token },
    });
    const body = await res.json().catch(() => ({}));
    process.stdout.write(JSON.stringify(body, null, 2) + "\n");
    return res.ok ? 0 : 1;
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

  const paymentMode = String(values["payment-mode"]);
  if (paymentMode !== "mock" && paymentMode !== "testnet") {
    process.stderr.write(`invalid --payment-mode: ${paymentMode}\n`);
    return 2;
  }

  const agent = command === "agent-demo";
  const client = new SandboxClient({
    apiUrl,
    paymentMode,
    ...(agent
      ? { payer: await createAgentPayer(paymentMode, apiUrl, (l) => err(l, quiet)) }
      : {}),
    store: new FileSessionStore(),
    log: (l) => err(l, quiet),
  });

  const attach = (id: string): SessionHandle => client.attach(id);

  const ctx: CommandContext = {
    values,
    positionals,
    apiUrl,
    json,
    quiet,
    paymentMode,
    client,
    attach,
    hasSeparator: argv.includes("--"),
  };
  const handler = commands[command];
  if (!handler) {
    process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
    return 2;
  }
  return handler(ctx);
}

/**
 * Map a thrown error to an exit code, writing the operator-facing line first.
 * A dead lease is 124 so a caller can tell "the sandbox went away" apart from a
 * plain API error, which is 1.
 */
export function reportFatal(error: unknown): number {
  if (error instanceof SessionExpiredError) {
    process.stderr.write(`error: ${error.message}\n`);
    return 124;
  }
  if (error instanceof SandboxError) {
    process.stderr.write(`error: ${error.code}: ${error.message}\n`);
    return 1;
  }
  process.stderr.write(`fatal: ${(error as Error).message}\n`);
  return 1;
}

/**
 * `main` is exported for tests, so the entry point has to be detected. When the
 * check cannot answer (no argv[1], unreadable path) the CLI runs, because a
 * script that silently does nothing is a worse failure than one that runs.
 */
function invokedAsScript(): boolean {
  const entry = process.argv[1];
  if (!entry) return true;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return true;
  }
}

if (invokedAsScript()) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => process.exit(reportFatal(error)));
}
