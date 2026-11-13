/**
 * Startup enforcement of the isolation boundary (#PR1 of the isolation track).
 *
 * `EXECUTION_MODE=kata` used to be a label: the real handler comes from the
 * cluster's RuntimeClass object, so a drifted overlay could leave the controller
 * advertising Kata while every guest ran on the host kernel. These tests pin the
 * fail-closed rule against the fake apiserver, which answers the same
 * `node.k8s.io/v1` verb a real API server does.
 *
 * The rule is deliberately narrow: `EXECUTION_MODE=dev`, or no Kubernetes API,
 * must not talk to a cluster at all. Local and test runs that never schedule a
 * pod cannot acquire a dependency on an object that only exists in one.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MICROVM_HANDLERS,
  parseMicrovmHandlers,
  verifyRuntimeClass,
} from "../../controller/src/config/kubernetes.js";
import { FakeApiServer } from "../helpers/fake-apiserver.js";

const servers: FakeApiServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function fakeApi(): Promise<FakeApiServer> {
  const api = await FakeApiServer.start();
  servers.push(api);
  return api;
}

function runtimeClass(name: string, handler?: string): Record<string, unknown> {
  return {
    apiVersion: "node.k8s.io/v1",
    kind: "RuntimeClass",
    metadata: { name },
    ...(handler === undefined ? {} : { handler }),
  };
}

function options(api: FakeApiServer, overrides: Record<string, unknown> = {}) {
  return {
    executionMode: "kata",
    runtimeClass: "x402-sandbox",
    kubeEnabled: true,
    kubeConfig: api.kubeConfig(),
    env: {},
    ...overrides,
  };
}

/** The rejection, so a test asserts one read per case instead of four. */
async function refusal(
  input: ReturnType<typeof options>,
): Promise<Error> {
  try {
    await verifyRuntimeClass(input);
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected verifyRuntimeClass to refuse, but it resolved");
}

describe("microVM handler allowlist", () => {
  it("defaults to the handlers the supported distributions register", () => {
    expect(parseMicrovmHandlers({})).toEqual([...DEFAULT_MICROVM_HANDLERS]);
    expect(DEFAULT_MICROVM_HANDLERS).toEqual(["kata", "kata-qemu", "kata-clh"]);
  });

  it("accepts an operator override, because handler names are distribution-specific", () => {
    expect(parseMicrovmHandlers({ KATA_RUNTIME_HANDLERS: "kata-fc, kata-qemu " })).toEqual([
      "kata-fc",
      "kata-qemu",
    ]);
  });

  it("refuses an override that names no handler instead of falling back", () => {
    // A typo must not be answered with the defaults and a green start.
    expect(() => parseMicrovmHandlers({ KATA_RUNTIME_HANDLERS: " , " })).toThrow(
      /KATA_RUNTIME_HANDLERS/,
    );
  });
});

describe("verifyRuntimeClass", () => {
  it("starts when the handler is a microVM one, and reports what it read", async () => {
    const api = await fakeApi();
    api.seedRuntimeClass(runtimeClass("x402-sandbox", "kata"));

    const check = await verifyRuntimeClass(options(api));

    expect(check).toEqual({
      enforced: true,
      runtimeClass: "x402-sandbox",
      handler: "kata",
      allowed: [...DEFAULT_MICROVM_HANDLERS],
    });
    // Read by name from the cluster-scoped API, not inferred from config.
    expect(api.calls("GET", /^\/apis\/node\.k8s\.io\/v1\/runtimeclasses\/x402-sandbox$/)).toHaveLength(1);
  });

  it("refuses a runc handler: the label would be a lie", async () => {
    const api = await fakeApi();
    api.seedRuntimeClass(runtimeClass("x402-sandbox", "runc"));

    const error = await refusal(options(api));
    expect(error.message).toContain('handler "runc"');
    expect(error.message).toContain("not a microVM handler");
    // The message has to name the fix, not only the symptom.
    expect(error.message).toContain("RUNTIME_CLASS");
    expect(error.message).toContain("KATA_RUNTIME_HANDLERS");
    expect(error.message).toContain("EXECUTION_MODE=dev");
  });

  it("refuses runsc and an unknown handler the same way", async () => {
    const gvisor = await fakeApi();
    gvisor.seedRuntimeClass(runtimeClass("x402-sandbox", "runsc"));
    await expect(verifyRuntimeClass(options(gvisor))).rejects.toThrow(/handler "runsc"/);

    const unknown = await fakeApi();
    unknown.seedRuntimeClass(runtimeClass("x402-sandbox", "mystery-runtime"));
    await expect(verifyRuntimeClass(options(unknown))).rejects.toThrow(/handler "mystery-runtime"/);
  });

  it("refuses a RuntimeClass with no handler at all", async () => {
    const api = await fakeApi();
    api.seedRuntimeClass(runtimeClass("x402-sandbox"));

    await expect(verifyRuntimeClass(options(api))).rejects.toThrow(/handler "<none>"/);
  });

  it("refuses a missing RuntimeClass, because the overlay did not create it", async () => {
    const api = await fakeApi();

    await expect(verifyRuntimeClass(options(api))).rejects.toThrow(/could not read RuntimeClass/);
    await expect(verifyRuntimeClass(options(api))).rejects.toThrow(/HTTP 404/);
  });

  it("refuses a read error, so a dead apiserver is not a pass", async () => {
    const api = await fakeApi();
    api.seedRuntimeClass(runtimeClass("x402-sandbox", "kata"));
    api.failNext("GET", /^\/apis\/node\.k8s\.io\/v1\/runtimeclasses\//, 500);

    await expect(verifyRuntimeClass(options(api))).rejects.toThrow(/HTTP 500/);
  });

  it("accepts a handler from KATA_RUNTIME_HANDLERS and nothing outside it", async () => {
    const api = await fakeApi();
    api.seedRuntimeClass(runtimeClass("x402-sandbox", "kata-fc"));

    const check = await verifyRuntimeClass(
      options(api, { env: { KATA_RUNTIME_HANDLERS: "kata-fc" } }),
    );
    expect(check.handler).toBe("kata-fc");

    api.seedRuntimeClass(runtimeClass("other", "kata-fc"));
    await expect(
      verifyRuntimeClass(options(api, { runtimeClass: "other", env: { KATA_RUNTIME_HANDLERS: "kata" } })),
    ).rejects.toThrow(/handler "kata-fc"/);
  });

  it("does not read the cluster in dev mode", async () => {
    const api = await fakeApi();

    const check = await verifyRuntimeClass(options(api, { executionMode: "dev" }));

    expect(check).toEqual({
      enforced: false,
      runtimeClass: "x402-sandbox",
      handler: null,
      allowed: [...DEFAULT_MICROVM_HANDLERS],
    });
    expect(api.requests).toHaveLength(0);
  });

  it("does not read the cluster when Kubernetes is disabled", async () => {
    const api = await fakeApi();

    const check = await verifyRuntimeClass(options(api, { kubeEnabled: false }));

    expect(check.enforced).toBe(false);
    expect(api.requests).toHaveLength(0);
  });
});
