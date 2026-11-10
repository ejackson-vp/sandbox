/**
 * Property tests for the HTTP request schemas and the payment header decoder.
 *
 * These are the API's untrusted-input edge: JSON bodies from anyone, and
 * PAYMENT-SIGNATURE headers from anyone. The invariants under test are that
 * validation is total (never throws for any input), failures are represented
 * as issues rather than exceptions, and the declared size caps are enforced
 * before a value can be forwarded.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fuzzSeed } from "./seeds.js";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { NextFunction, Request, Response } from "express";
import {
  createSchema,
  operationSchema,
  rejectPlaintextBodies,
  requestIdSchema,
} from "../../api/src/schemas.js";

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_ENVELOPE = 16 * 1024 * 1024;

/** Arbitrary JSON, plus the non-JSON shapes a body parser can hand us. */
const arbitraryBody = fc.oneof(
  fc.jsonValue(),
  fc.constant(undefined),
  fc.constant(null),
  fc.double({ noNaN: false }),
);

const arbitraryJsonValue = fc.oneof(fc.jsonValue(), fc.constant(null), fc.constant(undefined));

describe("createSchema", () => {
  it("never throws for arbitrary JSON and reports issues in a serialisable form", () => {
    fc.assert(
      fc.property(arbitraryBody, (body) => {
        const parsed = createSchema.safeParse(body);
        if (parsed.success) {
          expect(parsed.data).toBeTypeOf("object");
          return;
        }
        expect(Array.isArray(parsed.error.issues)).toBe(true);
        expect(() => JSON.stringify(parsed.error.issues)).not.toThrow();
      }),
      { numRuns: 300, ...fuzzSeed },
    );
  });

  it("accepts a well-formed create body and rejects key material outside 40-64 chars", () => {
    const base = { clientPublicKey: "p".repeat(40), clientNonce: "n".repeat(40) };
    expect(createSchema.safeParse(base).success).toBe(true);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 200 }), fc.integer({ min: 0, max: 200 }), (pk, nn) => {
        const parsed = createSchema.safeParse({
          clientPublicKey: "p".repeat(pk),
          clientNonce: "n".repeat(nn),
        });
        const inRange = pk >= 40 && pk <= 64 && nn >= 40 && nn <= 64;
        expect(parsed.success).toBe(inRange);
      }),
      { numRuns: 100, ...fuzzSeed },
    );
  });

  it("rejects a clientSignature that is not a 65-byte hex signature", () => {
    fc.assert(
      fc.property(fc.string(), (signature) => {
        const parsed = createSchema.safeParse({
          clientPublicKey: "p".repeat(40),
          clientNonce: "n".repeat(40),
          clientSignature: signature,
        });
        expect(parsed.success).toBe(/^0x[0-9a-fA-F]{130}$/.test(signature));
      }),
      { numRuns: 200, ...fuzzSeed },
    );
  });
});

describe("operationSchema", () => {
  it("never throws for arbitrary bodies", () => {
    fc.assert(
      fc.property(arbitraryJsonValue, (body) => {
        const parsed = operationSchema.safeParse(body);
        if (parsed.success) {
          expect(parsed.data.envelope.length).toBeGreaterThan(0);
          expect(parsed.data.envelope.length).toBeLessThanOrEqual(MAX_ENVELOPE);
          return;
        }
        expect(Array.isArray(parsed.error.issues)).toBe(true);
      }),
      { numRuns: 300, ...fuzzSeed },
    );
  });

  it("accepts only request ids matching the shared pattern", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 160 }), (requestId) => {
        const parsed = operationSchema.safeParse({ requestId, envelope: "AAAA" });
        const expected = REQUEST_ID.test(requestId);
        expect(requestIdSchema.safeParse(requestId).success).toBe(expected);
        expect(parsed.success).toBe(expected);
      }),
      { numRuns: 300, ...fuzzSeed },
    );
  });

  it("rejects an envelope above the 16 MiB cap instead of forwarding it", () => {
    const oversized = "A".repeat(MAX_ENVELOPE + 1);
    const parsed = operationSchema.safeParse({
      requestId: "request-1234",
      envelope: oversized,
    });
    expect(parsed.success).toBe(false);
  });

  it("bounds timeoutMs and waitMs", () => {
    fc.assert(
      fc.property(fc.integer({ min: -10_000, max: 5_000_000 }), (value) => {
        const parsed = operationSchema.safeParse({
          requestId: "request-1234",
          envelope: "AAAA",
          timeoutMs: value,
          waitMs: value,
        });
        const timeoutOK = value >= 100 && value <= 3_600_000;
        const waitOK = value >= 0 && value <= 120_000;
        expect(parsed.success).toBe(timeoutOK && waitOK);
      }),
      { numRuns: 200, ...fuzzSeed },
    );
  });
});

describe("rejectPlaintextBodies", () => {
  function run(body: unknown): { status?: number; next: boolean } {
    const result: { status?: number; next: boolean } = { next: false };
    const res = {
      status(code: number) {
        result.status = code;
        return this;
      },
      json() {
        return this;
      },
    } as unknown as Response;
    const req = { body } as unknown as Request;
    const next: NextFunction = () => {
      result.next = true;
    };
    rejectPlaintextBodies(req, res, next);
    return result;
  }

  it("never throws and always either rejects with 400 or calls next", () => {
    fc.assert(
      fc.property(arbitraryBody, (body) => {
        const outcome = run(body);
        expect(outcome.next !== (outcome.status === 400)).toBe(true);
      }),
      { numRuns: 300, ...fuzzSeed },
    );
  });

  it("rejects every forbidden plaintext field", () => {
    const fields = [
      "code",
      "source",
      "script",
      "command",
      "args",
      "argv",
      "env",
      "cwd",
      "stdin",
      "stdout",
      "stderr",
      "content",
      "data",
      "plaintext",
    ];
    for (const field of fields) {
      const outcome = run({ [field]: "x" });
      expect(outcome.status).toBe(400);
      expect(outcome.next).toBe(false);
    }
    expect(run({ envelope: "AAAA" }).next).toBe(true);
  });

  it("ignores non-object bodies", () => {
    for (const body of [null, undefined, "string", 42, true]) {
      expect(run(body).next).toBe(true);
    }
  });
});

describe("payment signature header decoding", () => {
  it("returns an object or throws an Error for any header value", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 512 }), (header) => {
        try {
          const decoded = decodePaymentSignatureHeader(header);
          expect(decoded).toBeTypeOf("object");
          expect(decoded).not.toBeNull();
        } catch (err) {
          // The create route catches every throw and answers 402; the only
          // requirement here is that the throw is a normal Error, not a
          // crash or a non-Error rejection.
          expect(err).toBeInstanceOf(Error);
          expect(String((err as Error).message).length).toBeLessThan(4096);
        }
      }),
      { numRuns: 300, ...fuzzSeed },
    );
  });

  it("accepts base64 JSON envelopes and rejects structurally invalid ones", () => {
    const encode = (value: unknown): string =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64");
    expect(decodePaymentSignatureHeader(encode({ x402Version: 2 }))).toMatchObject({
      x402Version: 2,
    });
    for (const bad of [encode(null), encode([]), encode("string"), "!!!!"]) {
      expect(() => decodePaymentSignatureHeader(bad)).toThrow(Error);
    }
  });
});
