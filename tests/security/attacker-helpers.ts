/**
 * Primitives for the anonymous attacker suite.
 *
 * Everything here talks to the deployment the way an unauthenticated client
 * would: raw sockets, HTTP over a forwarding proxy, and a WebSocket upgrade sent
 * by hand. Nothing calls an internal function to decide the outcome, because the
 * claim under test is about what the deployed edge does with hostile traffic.
 *
 * Split out of `attacker.test.ts` to keep both files inside the 650-line limit;
 * the helpers are deliberately dumb so a case reads as the attack it describes.
 */
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { CONTEXT, deployConfig } from "./kubectl.js";

export const API = process.env.API_URL ?? "http://localhost:8080";
export const API_URL = new URL(API);

// `deployConfig` lives with the other cluster reads now that the workload suite
// needs the same value; re-exported so this file's importers are unchanged.
export { deployConfig };

/** The payment mode the deployed API advertises, or "" when it is unreachable. */
export async function apiHealth(): Promise<{ ok: boolean; paymentMode: string } | null> {
  try {
    const response = await fetch(`${API}/healthz`);
    if (!response.ok) return null;
    const body = (await response.json()) as { paymentMode?: string };
    return { ok: true, paymentMode: String(body.paymentMode ?? "") };
  } catch {
    return null;
  }
}

export interface Attempt {
  status: number;
  retryAfter: string | null;
  body: unknown;
}

/** One unpaid create, the cheapest request that reaches the IP limiter. */
export async function createAttempt(
  base: string,
  headers: Record<string, string> = {},
): Promise<Attempt> {
  const response = await fetch(`${base}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      // Valid shapes, so the limiter is the thing that answers, not a schema.
      clientPublicKey: randomBase64(),
      clientNonce: randomBase64(),
    }),
  });
  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    body: await response.json().catch(() => null),
  };
}

export function randomBase64(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
}

/**
 * The single path the client already uses to reach the API.
 *
 * `API` is reached through one forwarding hop in every deployment: a kind port
 * mapping, a `kubectl port-forward`, or the public tunnel. A second listener on
 * this machine adds nothing to the property under test (the limiter keys on one
 * peer either way) and cannot carry the burst: macOS caps the accept queue at
 * 128 (`kern.ipc.somaxconn`), so a 180-connection burst to a local Node listener
 * is reset before the API is involved (measured: 52/180 `ECONNRESET`, exactly
 * 128 accepted, for HTTP and raw TCP alike). That reset is the runner, and it
 * made this case report a forwarder failure instead of the limiter's answer.
 */
export async function singlePathProxy(): Promise<{ url: string; close(): Promise<void> }> {
  return { url: API, close: async () => undefined };
}

/**
 * Spend the create budget until the limiter answers, so a later case starts
 * from a known state instead of assuming the previous case left one.
 */
export async function drainCreateBudget(
  base: string,
  headers: Record<string, string> = {},
  attempts = 200,
): Promise<Attempt[]> {
  const seen: Attempt[] = [];
  for (let i = 0; i < attempts; i += 1) {
    const attempt = await createAttempt(base, headers);
    seen.push(attempt);
    if (attempt.status === 429) break;
  }
  return seen;
}

/**
 * A request that never finishes its headers. The server must close it on
 * `headersTimeout` rather than hold a slot; the caller checks that liveness
 * still answers while the socket is held.
 */
export function slowloris(
  host: string,
  port: number,
  holdMs: number,
): Promise<{ closed: boolean; closedAfterMs: number; statusDuring: number | null }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    let settled = false;
    let healthStatus: number | null = null;

    // Started at connect, awaited before resolving: an edge that refuses the
    // hostile socket in under two seconds is good behaviour, and the old code
    // then reported `statusDuring: null` because the health probe had not
    // returned yet. The property is "the API answers while a socket is held",
    // not "the socket is still held when the probe returns".
    let healthPromise: Promise<number> | null = null;

    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearInterval(trickle);
      clearTimeout(deadline);
      socket.destroy();
      void (healthPromise ?? Promise.resolve(healthStatus ?? 0)).then((status) => {
        resolve({ closed, closedAfterMs: Date.now() - started, statusDuring: status });
      });
    };

    const trickle = setInterval(() => {
      // One header byte at a time, forever: the classic slowloris hold.
      socket.write("X-a: b\r\n");
    }, 1_000);
    const deadline = setTimeout(() => finish(false), holdMs);

    socket.on("connect", () => {
      socket.write(
        "POST /v1/sessions HTTP/1.1\r\n" +
          `Host: ${host}:${port}\r\n` +
          "Content-Type: application/json\r\n" +
          "Content-Length: 100000\r\n",
      );
      // Liveness must not depend on a hostile socket. One probe, awaited by
      // finish() whether the socket survives or not.
      healthPromise = fetch(`${API}/healthz`, { signal: AbortSignal.timeout(10_000) })
        .then((response) => {
          healthStatus = response.status;
          return response.status;
        })
        .catch(() => {
          healthStatus = 0;
          return 0;
        });
    });
    socket.on("close", () => finish(true));
    socket.on("error", () => finish(true));
  });
}

/** A body larger than `MAX_BODY_BYTES`, sent to the create route. */
export function oversizedBody(
  host: string,
  port: number,
  bytes: number,
): Promise<{ status: number | null; error: string | null }> {
  return new Promise((resolve) => {
    const payload = Buffer.alloc(bytes, 0x20);
    const request = http.request(
      {
        host,
        port,
        method: "POST",
        path: "/v1/sessions",
        headers: { "content-type": "application/json", "content-length": payload.length },
        timeout: 30_000,
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode ?? null, error: null }));
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve({ status: null, error: "timeout" });
    });
    request.on("error", (error: Error) => resolve({ status: null, error: error.message }));
    request.end(payload);
  });
}

/**
 * Send a WebSocket upgrade by hand and return the status line the relay wrote.
 *
 * A refusal happens before the upgrade is completed, which is why the status
 * code is the evidence: 401 means the token did not match that session's
 * registration, 404 means the session was never registered.
 */
export function upgradeStatus(port: number, path: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let buffer = "";
    const done = (): void => {
      socket.destroy();
      resolve(buffer.split("\r\n")[0] ?? "no response");
    };
    socket.on("connect", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          "Host: relay\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "Sec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\r\n")) done();
    });
    socket.on("error", (error: Error) => {
      buffer = `error ${error.message}`;
      done();
    });
    setTimeout(done, 5_000);
  });
}

/** A local port free at the moment it is asked for. */
export async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * A port-forward to a control-plane Service.
 *
 * Used for the relay, which is not published outside the cluster: port-forwarding
 * is the operator's own access path, and it is the only way the test process can
 * send an upgrade to the listener a guest would reach.
 */
export async function portForward(
  target: string,
  remotePort: number,
): Promise<{ port: number; stop(): void }> {
  const port = await freePort();
  const child = spawn(
    "kubectl",
    [
      "--context",
      CONTEXT,
      "-n",
      "sandbox-system",
      "port-forward",
      target,
      `${port}:${remotePort}`,
      "--address",
      "127.0.0.1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`port-forward to ${target} did not start`)), 30_000);
    const onData = (chunk: Buffer): void => {
      if (!chunk.toString("utf8").includes("Forwarding from")) return;
      clearTimeout(timer);
      resolve();
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`port-forward to ${target} exited with ${code}`));
    });
  });

  return {
    port,
    stop: () => {
      child.kill("SIGTERM");
    },
  };
}
