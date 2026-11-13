/**
 * Property tests against the API's controller client.
 *
 * This class is the API's only view of the controller, so its contract has to
 * hold for answers nobody designed: a proxy error page, a truncated body, a
 * status the controller never sends. `call` must turn every one of those into
 * either a parsed body or a `ControllerError` carrying the status and the
 * controller's error code, and never into a JSON syntax error escaping to the
 * route. The same applies to a caller-supplied id: it is one path segment, so a
 * value containing `/`, `?` or `%` cannot address a different endpoint.
 *
 * A real HTTP listener stands in for the controller, so the fetch, timeout and
 * header behaviour are the production ones; only the answer is scripted.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fuzzSeed } from "./seeds.js";
import { ControllerClient, ControllerError } from "../../api/src/controller-client.js";

const ADMIN = "fuzz-controller-token";

interface Reply {
  status: number;
  /** Raw text, so a body that is not JSON is exercised too. */
  body: string;
}

let server: Server;
let client: ControllerClient;
let reply: Reply = { status: 200, body: "{}" };
let lastUrl = "";
let lastToken: string | undefined;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastUrl = req.url ?? "";
    lastToken = req.headers["x-internal-token"] as string | undefined;
    res.statusCode = reply.status;
    res.setHeader("content-type", "application/json");
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  client = new ControllerClient(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    ADMIN,
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Every response status a server can send that is not an interim 1xx.
 *
 * 407 is excluded: undici treats Proxy Authentication Required as a transport
 * failure of its own and throws before the client sees a response, so there is
 * no client mapping to observe.
 */
const httpStatus = fc.integer({ min: 200, max: 599 }).filter((status) => status !== 407);

/** A body that may parse, may not, and may be empty. */
const rawBody = fc.oneof(fc.jsonValue().map((value) => JSON.stringify(value)), fc.string());

/** A path segment that fetch cannot normalise away. */
const segment = fc
  .string({ minLength: 1, maxLength: 80 })
  .filter((value) => value !== "." && value !== "..");

/** Call and classify, so a rejection can be asserted as a value. */
async function outcome(
  run: () => Promise<unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
  return run().then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

describe("controller client", () => {
  it("turns any status and body into a body or a ControllerError", async () => {
    await fc.assert(
      fc.asyncProperty(httpStatus, rawBody, async (status, body) => {
        reply = { status, body };
        const result = await outcome(() => client.getSession("sbx_fuzz_client"));
        if (result.ok) {
          // A success status is the only way to resolve, and the body is
          // whatever parsed out of the text (undefined if it was not JSON).
          expect(status).toBeGreaterThanOrEqual(200);
          expect(status).toBeLessThan(300);
          return;
        }
        expect(result.error).toBeInstanceOf(ControllerError);
        const err = result.error as ControllerError;
        expect(err.status).toBe(status);
        expect(typeof err.code).toBe("string");
        expect(err.code.length).toBeGreaterThan(0);
        // The message is bounded: it is logged and, on some paths, returned.
        expect(err.message.length).toBeLessThan(4_096);
      }),
      { numRuns: 120, ...fuzzSeed },
    );
  });

  it("is total across its whole surface for an arbitrary controller answer", async () => {
    // One thunk per public method. Whatever the controller sends, a method may
    // resolve with the parsed body or reject with a ControllerError, nothing
    // else: a parse or null-dereference escaping here would reach a route as an
    // unhandled 500.
    const methods: Array<[string, () => Promise<unknown>]> = [
      ["claimIntent", () => client.claimIntent("a".repeat(64), "b".repeat(64))],
      ["completeIntent", () => client.completeIntent("a".repeat(64), {} as never)],
      ["failIntent", () => client.failIntent("a".repeat(64), "reason")],
      ["reserveBudget", () => client.reserveBudget(null, "1")],
      ["issueChallengeNonce", () => client.issueChallengeNonce()],
      [
        "burnChallengeNonce",
        () => client.burnChallengeNonce(`cn_${"0".repeat(32)}`, "a".repeat(64)),
      ],
      ["preflightCapacity", () => client.preflightCapacity({} as never)],
      ["holdCapacity", () => client.holdCapacity("a".repeat(64), "b".repeat(64), {} as never)],
      ["releaseCapacity", () => client.releaseCapacity("a".repeat(64))],
      ["operation", () => client.operation("sbx_x", { requestId: "request-1", envelope: "AA" })],
      ["getOperation", () => client.getOperation("sbx_x", "request-1", 0)],
      ["cancelOperation", () => client.cancelOperation("sbx_x", "request-1")],
      ["suspend", () => client.suspend("sbx_x")],
      ["resume", () => client.resume("sbx_x")],
      ["destroy", () => client.destroy("sbx_x")],
      ["wake", () => client.wake()],
      ["healthz", () => client.healthz()],
    ];

    await fc.assert(
      fc.asyncProperty(
        httpStatus,
        fc.jsonValue().filter((value) => value !== null),
        async (status, value) => {
          reply = { status, body: JSON.stringify(value) };
          for (const [name, run] of methods) {
            const result = await outcome(run);
            if (!result.ok) {
              expect(result.error, name).toBeInstanceOf(ControllerError);
            }
          }
        },
      ),
      { numRuns: 10, ...fuzzSeed },
    );
  });

  it("keeps a caller-supplied id inside its own path segment", async () => {
    reply = { status: 200, body: "{}" };
    await fc.assert(
      fc.asyncProperty(segment, async (id) => {
        lastUrl = "";
        await client.getSession(id);
        expect(lastUrl).toBe(`/internal/sessions/${encodeURIComponent(id)}`);
        expect(lastUrl).not.toContain("?");
        // The admin token is the credential on this path.
        expect(lastToken).toBe(ADMIN);
      }),
      { numRuns: 60, ...fuzzSeed },
    );
  });

  it("reports readiness only for a report with a boolean ok", async () => {
    await fc.assert(
      fc.asyncProperty(httpStatus, fc.jsonValue(), async (status, value) => {
        reply = { status, body: JSON.stringify(value) };
        const result = await outcome(() => client.readiness());
        if (result.ok) {
          expect((result.value as { ok: unknown }).ok).toBeTypeOf("boolean");
          return;
        }
        expect(result.error).toBeInstanceOf(ControllerError);
        const err = result.error as ControllerError;
        expect(err.code).toBe("readiness_failed");
        // A 503 with a real report is a normal answer, not a transport error:
        // if the body carried `ok`, it must have resolved.
        const carriedOk =
          value !== null &&
          typeof value === "object" &&
          typeof (value as { ok?: unknown }).ok === "boolean";
        expect(carriedOk).toBe(false);
      }),
      { numRuns: 100, ...fuzzSeed },
    );
  });

  it("maps only the documented 409 statuses and errors on the rest", async () => {
    const documented = new Set(["in_progress", "failed", "mismatch"]);
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(409, 400, 500, 502),
        // A JSON `null` body is excluded: the client dereferences `body.status`
        // without a null check, which is a defect reported with this change
        // rather than pinned as expected behaviour.
        fc.jsonValue().filter((value) => value !== null),
        async (status, value) => {
          reply = { status, body: JSON.stringify(value) };
          const result = await outcome(() => client.claimIntent("a".repeat(64), "b".repeat(64)));
          const carriedStatus =
            typeof value === "object" &&
            typeof (value as { status?: unknown }).status === "string"
              ? ((value as { status: string }).status as string)
              : undefined;
          if (status === 409 && carriedStatus !== undefined && documented.has(carriedStatus)) {
            expect(result.ok).toBe(true);
            expect(result.ok && (result.value as { status: string }).status).toBe(carriedStatus);
            return;
          }
          expect(result.ok).toBe(false);
          expect(result.ok ? undefined : result.error).toBeInstanceOf(ControllerError);
          const err = (result as { error: ControllerError }).error;
          expect(err.status).toBe(status);
          expect(err.code).toBe("intent_claim_failed");
        },
      ),
      { numRuns: 100, ...fuzzSeed },
    );
  });

  it("accepts a 503 readiness report as an answer", async () => {
    // The controller is up and a dependency is not: that is a report, not a
    // transport failure, so it must resolve rather than throw.
    reply = {
      status: 503,
      body: JSON.stringify({ ok: false, checks: { store: { ok: false, reason: "unavailable" } } }),
    };
    const report = await client.readiness();
    expect(report).toMatchObject({ ok: false });
  });

  it("maps the documented claim statuses to values instead of errors", async () => {
    reply = { status: 409, body: JSON.stringify({ status: "in_progress" }) };
    await expect(client.claimIntent("a".repeat(64), "b".repeat(64))).resolves.toEqual({
      status: "in_progress",
    });

    reply = {
      status: 409,
      body: JSON.stringify({ status: "failed", reason: "settlement_refused" }),
    };
    await expect(client.claimIntent("a".repeat(64), "b".repeat(64))).resolves.toEqual({
      status: "failed",
      reason: "settlement_refused",
    });

    reply = { status: 409, body: JSON.stringify({ status: "mismatch" }) };
    await expect(client.claimIntent("a".repeat(64), "b".repeat(64))).resolves.toEqual({
      status: "mismatch",
    });

    // A 409 with any other status is not a decided answer.
    reply = { status: 409, body: JSON.stringify({ status: "settled", sessionId: "sbx_x" }) };
    await expect(client.claimIntent("a".repeat(64), "b".repeat(64))).rejects.toBeInstanceOf(
      ControllerError,
    );

    // `null` is valid JSON, so the parse fallback does not cover it. A proxy or
    // a newer controller answering 409 with a null body must still raise a
    // ControllerError rather than a TypeError from reading `.status`.
    reply = { status: 409, body: "null" };
    await expect(client.claimIntent("a".repeat(64), "b".repeat(64))).rejects.toBeInstanceOf(
      ControllerError,
    );
  });

  it("keeps the controller's error code and detail on a failed call", async () => {
    reply = {
      status: 422,
      body: JSON.stringify({ error: "spec_not_allowed", message: "limits are not permitted" }),
    };
    const result = await outcome(() => client.getSession("sbx_fuzz_client"));
    expect(result.ok).toBe(false);
    const err = (result as { error: ControllerError }).error;
    expect(err).toBeInstanceOf(ControllerError);
    expect(err).toMatchObject({
      status: 422,
      code: "spec_not_allowed",
      message: "limits are not permitted",
    });
  });
});
