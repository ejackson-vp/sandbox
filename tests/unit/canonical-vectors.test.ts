/**
 * Cross-language conformance for canonical JSON.
 *
 * `canonicalJson` signs attestation evidence and payment identity keys on the
 * SDK side; the Go guest signs the same evidence with `canonical.Marshal`. The
 * shared fixture pins the bytes both must produce, so a change to either
 * implementation fails here instead of at signature verification.
 *
 * The fixture is plain JSON with no dependencies so the Go test can read the
 * same file. See guest/internal/canonical/canonical_vectors_test.go.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../shared/src/entries/crypto.js";

interface Vector {
  name: string;
  input: unknown;
  expected: string;
  note?: string;
}

interface Fixture {
  description: string;
  numberPolicy: string;
  vectors: Vector[];
}

const fixturePath = new URL("../fixtures/canonical-vectors.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

describe("canonical JSON conformance vectors", () => {
  it("loads a populated fixture with unique case names", () => {
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(50);
    const names = fixture.vectors.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });

  for (const vector of fixture.vectors) {
    it(vector.name, () => {
      expect(canonicalJson(vector.input)).toBe(vector.expected);
    });
  }
});
