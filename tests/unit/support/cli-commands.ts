/**
 * The scratch directory, output capture and `run` helper shared by the CLI
 * command suites.
 *
 * `cli-commands.test.ts` covered every handler in the registry and grew past the
 * module budget, so it is split by command family. What is left here is the
 * setup each family needs and nothing else: a temp directory per test, capture
 * of stdout/stderr instead of the terminal, and a `run` that hands the command a
 * fake client and returns its exit code plus both streams. No server, no
 * sockets, no sleeps.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, vi } from "vitest";
import { commands } from "../../../cli/src/commands.js";
import { captureWrites, cliContext, type FakeClient } from "../helpers/cli.js";

export interface CliFixture {
  /** This test's scratch directory. */
  readonly dir: string;
  /** Run one registry command against `client` and collect what it wrote. */
  run(
    name: string,
    client: FakeClient,
    overrides?: Parameters<typeof cliContext>[1],
  ): Promise<{ code: number; out: string; err: string }>;
}

/**
 * Register the per-test hooks and return the fixture they populate.
 *
 * Call it once at module scope: the hooks are file-scoped, so each suite owns
 * its own capture and directory.
 */
export function cliFixture(): CliFixture {
  let capture: ReturnType<typeof captureWrites> | undefined;
  let dir = "";

  beforeEach(() => {
    capture = captureWrites();
    dir = mkdtempSync(join(tmpdir(), "x402-cli-"));
  });

  afterEach(() => {
    capture?.restore();
    vi.restoreAllMocks();
  });

  return {
    get dir() {
      return dir;
    },
    async run(
      name: string,
      client: FakeClient,
      overrides: Parameters<typeof cliContext>[1] = {},
    ): Promise<{ code: number; out: string; err: string }> {
      const code = await commands[name]!(cliContext(client, overrides));
      return { code, out: capture!.stdout(), err: capture!.stderr() };
    },
  };
}

/**
 * A gzipped tar holding one member. `tar -czf` will not store a `..` member, so
 * the unsafe-archive check has to be handed a hand-built ustar header.
 */
export function tarArchive(name: string, body: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100, "utf8");
  header.write("0000000\0", 108, "utf8");
  header.write("0000000\0", 116, "utf8");
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "utf8");
  header.write("00000000000\0", 136, "utf8");
  header.fill(" ", 148, 156);
  header.write("0", 156, "utf8");
  header.write("ustar", 257, "utf8");
  header.write("00", 263, "utf8");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
  const data = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  data.write(body, 0, "utf8");
  return gzipSync(Buffer.concat([header, data, Buffer.alloc(1024)]));
}
