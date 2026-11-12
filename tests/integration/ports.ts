/**
 * Host ports for integration fixtures.
 *
 * Each suite binds a fixed port so failures are reproducible, but fixed ports
 * make two concurrent runs collide with EADDRINUSE: parallel worktrees, or a
 * leftover suite from a killed run. Offset the whole set per run instead of
 * editing every file:
 *
 *   X402_TEST_PORT_BASE=1000 npx vitest run tests/integration
 *
 * The default is 0, so CI and `make verify` keep the original ports.
 */
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

const raw = process.env.X402_TEST_PORT_BASE ?? "0";
const base = Number(raw);

if (!Number.isInteger(base) || base < 0 || base > 20000) {
  throw new Error(`X402_TEST_PORT_BASE must be an integer between 0 and 20000, got ${raw}`);
}

export function testPort(port: number): number {
  const shifted = port + base;
  if (shifted > 65535) {
    throw new Error(`port ${port} plus base ${base} exceeds 65535`);
  }
  return shifted;
}

/**
 * Ask the kernel for an unused loopback port.
 *
 * A fixed port is fine for the API and relay fixtures because they are offset
 * per run. It is not fine for a service started inside a guest: another
 * developer container on the host can already own the port, which is how the
 * loopback HTTP test failed against 18080. Bind port 0, read the assignment,
 * release it, and hand it to the guest.
 */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
