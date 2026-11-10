import { describe, expect, it, vi } from "vitest";
import { ServiceAddressResolver } from "../../controller/src/service-address.js";

describe("ServiceAddressResolver", () => {
  it("caches a stable service for the TTL", async () => {
    let now = 1_000;
    const load = vi.fn(async () => ({ host: "10.0.0.1", port: 8443 }));
    const resolver = new ServiceAddressResolver(() => now, 30_000);

    expect(await resolver.resolve("proxy", load, { cache: true })).toEqual({ host: "10.0.0.1", port: 8443 });
    now += 29_999;
    expect(await resolver.resolve("proxy", load, { cache: true })).toEqual({ host: "10.0.0.1", port: 8443 });
    expect(load).toHaveBeenCalledTimes(1);

    now += 1;
    expect(await resolver.resolve("proxy", load, { cache: true })).toEqual({ host: "10.0.0.1", port: 8443 });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("always reloads when caching is disabled", async () => {
    let host = "10.0.0.1";
    const load = vi.fn(async () => ({ host, port: 8443 }));
    const resolver = new ServiceAddressResolver(() => 1_000);

    expect(await resolver.resolve("relay", load, { cache: false })).toEqual({ host: "10.0.0.1", port: 8443 });
    host = "10.0.0.2";
    expect(await resolver.resolve("relay", load, { cache: false })).toEqual({ host: "10.0.0.2", port: 8443 });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed lookup", async () => {
    let attempt = 0;
    const load = vi.fn(async () => (++attempt === 1 ? null : { host: "10.0.0.3", port: 8443 }));
    const resolver = new ServiceAddressResolver(() => 1_000);

    expect(await resolver.resolve("proxy", load, { cache: true })).toBeNull();
    expect(await resolver.resolve("proxy", load, { cache: true })).toEqual({ host: "10.0.0.3", port: 8443 });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
