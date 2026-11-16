/**
 * The relay's per-session response cache.
 *
 * These pin the two rules the registry relies on: an id that already has an
 * answer is never sent again, and the structure stays bounded. The registry's
 * end-to-end behaviour is covered elsewhere; this is the memory bound on its
 * own, which is what a long-lived session with thousands of operations tests.
 */
import { describe, expect, it } from "vitest";
import { ResponseCache } from "../../controller/src/relay/response-cache.js";

const TTL_MS = 1_000;
/** Mirrors the private cap: the oldest entries go first. */
const CAP = 64;

function fill(cache: ResponseCache, count: number): void {
  for (let i = 0; i < count; i += 1) cache.remember(`id-${i}`, `envelope-${i}`, 0);
}

describe("relay response cache", () => {
  it("answers a retry with the stored envelope", () => {
    const cache = new ResponseCache(TTL_MS);
    expect(cache.has("op")).toBe(false);

    cache.remember("op", "sealed-result", 0);

    expect(cache.has("op")).toBe(true);
    expect(cache.response("op")?.envelope).toBe("sealed-result");
  });

  it("treats a cached error as an answer, not as a missing entry", () => {
    const cache = new ResponseCache(TTL_MS);

    cache.rememberError("op", "guest_error", "command failed", 0);

    // has() is the "do not resend" test: an error must not cause a retry.
    expect(cache.has("op")).toBe(true);
    expect(cache.response("op")).toBeUndefined();
    expect(cache.error("op")).toEqual({ code: "guest_error", message: "command failed" });
  });

  it("keeps an answer up to the TTL and drops it after", () => {
    const cache = new ResponseCache(TTL_MS);
    cache.remember("op", "sealed-result", 0);

    // The bound is exclusive: an entry exactly at the TTL is still a hit.
    cache.expire(TTL_MS);
    expect(cache.has("op")).toBe(true);

    cache.expire(TTL_MS + 1);
    expect(cache.has("op")).toBe(false);
  });

  it("drops an error after the TTL on the same rule", () => {
    const cache = new ResponseCache(TTL_MS);
    cache.rememberError("op", "guest_error", "command failed", 0);

    cache.expire(TTL_MS + 1);

    expect(cache.has("op")).toBe(false);
    expect(cache.error("op")).toBeUndefined();
  });

  it("evicts the oldest answers past the cap and keeps the newest", () => {
    const cache = new ResponseCache(TTL_MS);

    fill(cache, CAP + 6);
    cache.expire(0);

    expect(cache.has("id-0")).toBe(false);
    expect(cache.has("id-5")).toBe(false);
    expect(cache.has(`id-${CAP + 5}`)).toBe(true);
  });

  it("applies the cap to answers and errors separately", () => {
    const cache = new ResponseCache(TTL_MS);

    fill(cache, CAP + 6);
    for (let i = 0; i < 6; i += 1) cache.rememberError(`error-${i}`, "guest_error", "failed", 0);
    cache.expire(0);

    // Filling the answer cache must not evict an error, or a failed operation
    // would be resent to the guest and reported as a duplicate.
    expect(cache.has("error-0")).toBe(true);
    expect(cache.has("id-0")).toBe(false);
    expect(cache.has(`id-${CAP + 5}`)).toBe(true);
  });
});
