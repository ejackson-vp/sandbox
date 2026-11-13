/**
 * Service and HTTP commands: serve, services, stop-service and http.
 *
 * Split out of cli-commands.test.ts. These are the two ways to reach a port
 * inside a guest, so they share a file: a long-running service registered with
 * a name and a port, and one HTTP request (buffered or streamed) through the
 * relay. Both assert the request shape and the exact line the operator sees.
 */
import { describe, expect, it, vi } from "vitest";
import { fakeClient, SESSION_ID } from "./helpers/cli.js";
import { cliFixture } from "./support/cli-commands.js";

const cli = cliFixture();

describe("serve, services and stop-service", () => {
  it("starts a service with the defaults", async () => {
    const client = fakeClient();
    const { code, out } = await cli.run("serve", client, {
      positionals: ["serve", SESSION_ID, "python3", "-m", "http.server"],
    });
    expect(code).toBe(0);
    expect(client.startService).toHaveBeenCalledWith(expect.anything(), {
      name: "web",
      port: 8080,
      command: ["python3", "-m", "http.server"],
    });
    expect(out).toContain("Service: web on 127.0.0.1:8080 (pid 42, running)");
  });

  it("honours --name, --port and --json", async () => {
    const client = fakeClient();
    const { out } = await cli.run("serve", client, {
      positionals: ["serve", SESSION_ID, "node", "server.js"],
      values: { name: "api", port: "3000" },
      json: true,
    });
    expect(client.startService).toHaveBeenCalledWith(expect.anything(), {
      name: "api",
      port: 3000,
      command: ["node", "server.js"],
    });
    expect((JSON.parse(out) as { port: number }).port).toBe(3000);
  });

  it("asks for a command and returns 2", async () => {
    const client = fakeClient();
    const { code, err } = await cli.run("serve", client, { positionals: ["serve", SESSION_ID] });
    expect(code).toBe(2);
    expect(err).toContain("serve requires -- <command>");
    expect(client.startService).not.toHaveBeenCalled();
  });

  it("says so when no service is running", async () => {
    const { out } = await cli.run("services", fakeClient(), { positionals: ["services", SESSION_ID] });
    expect(out).toBe("No services\n");
  });

  it("prints a service table", async () => {
    const client = fakeClient({
      listServices: vi.fn(async () => [
        { name: "web", state: "running", port: 8080, pid: 42, startedAt: 0 },
      ]),
    });
    const { out } = await cli.run("services", client, { positionals: ["services", SESSION_ID] });
    expect(out).toBe("web\trunning\t127.0.0.1:8080\tpid 42\n");
  });

  it("prints services as JSON", async () => {
    const client = fakeClient({
      listServices: vi.fn(async () => [
        { name: "web", state: "running", port: 8080, pid: 42, startedAt: 0 },
      ]),
    });
    const { out } = await cli.run("services", client, { positionals: ["services", SESSION_ID], json: true });
    expect((JSON.parse(out) as unknown[]).length).toBe(1);
  });

  it("stops a named service", async () => {
    const client = fakeClient();
    const { code, out } = await cli.run("stop-service", client, {
      positionals: ["stop-service", SESSION_ID, "web"],
    });
    expect(code).toBe(0);
    expect(client.stopService).toHaveBeenCalledWith(expect.anything(), "web");
    expect(out).toBe("Service web: stopped\n");
  });

  it("requires a service name", async () => {
    await expect(
      cli.run("stop-service", fakeClient(), { positionals: ["stop-service", SESSION_ID] }),
    ).rejects.toThrow("missing service name");
  });
});

describe("http", () => {
  it("prints the status line and the body", async () => {
    const client = fakeClient();
    const { code, out } = await cli.run("http", client, { positionals: ["http", SESSION_ID, "8080"] });
    expect(code).toBe(0);
    expect(client.http).toHaveBeenCalledWith(expect.anything(), {
      port: 8080,
      path: "/",
      method: "GET",
    });
    expect(out).toBe("HTTP 200\nok");
  });

  it("passes method, path and body", async () => {
    const client = fakeClient();
    await cli.run("http", client, {
      positionals: ["http", SESSION_ID, "8080", "/submit"],
      values: { method: "POST", body: "x=1" },
    });
    expect(client.http).toHaveBeenCalledWith(expect.anything(), {
      port: 8080,
      path: "/submit",
      method: "POST",
      body: "x=1",
    });
  });

  it("notes a truncated body on stderr", async () => {
    const client = fakeClient({
      http: vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.from("cut"), truncated: true })),
    });
    const { err } = await cli.run("http", client, { positionals: ["http", SESSION_ID, "8080"] });
    expect(err).toContain("[response truncated]");
  });

  it("emits base64 body, headers and status with --json", async () => {
    const { out } = await cli.run("http", fakeClient(), {
      positionals: ["http", SESSION_ID, "8080"],
      json: true,
    });
    const parsed = JSON.parse(out) as { status: number; body: string; truncated: boolean };
    expect(parsed.status).toBe(200);
    expect(Buffer.from(parsed.body, "base64").toString()).toBe("ok");
    expect(parsed.truncated).toBe(false);
  });

  it("streams the response and closes the stream", async () => {
    const parts = [{ chunk: Buffer.from("one"), done: false }, { chunk: Buffer.from("two"), done: true }];
    const close = vi.fn(async () => undefined);
    const client = fakeClient({
      openHttpStream: vi.fn(async () => ({
        streamId: "s1",
        status: 200,
        headers: {},
        read: vi.fn(async () => parts.shift() ?? { done: true }),
        close,
      })),
    });
    const { code, out } = await cli.run("http", client, {
      positionals: ["http", SESSION_ID, "8080"],
      values: { stream: true },
    });
    expect(code).toBe(0);
    expect(out).toBe("onetwo");
    expect(close).toHaveBeenCalledTimes(1);
    expect(client.http).not.toHaveBeenCalled();
  });
});
