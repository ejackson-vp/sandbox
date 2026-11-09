import { describe, expect, it } from "vitest";
import { envBool, envInt } from "../../shared/src/env.js";

describe("env parsing", () => {
  it("treats unset and empty as the default", () => {
    expect(envBool(undefined, true)).toBe(true);
    expect(envBool("", false)).toBe(false);
    expect(envInt(undefined, 7, 1, 10)).toBe(7);
    expect(envInt("", 7, 1, 10)).toBe(7);
  });

  it("accepts the documented truthy spellings", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on"]) {
      expect(envBool(value)).toBe(true);
    }
    expect(envBool("0")).toBe(false);
    expect(envBool("no")).toBe(false);
  });

  it("throws on a malformed or out-of-range integer", () => {
    expect(() => envInt("abc", 1, 1, 10)).toThrow(/invalid integer/);
    expect(() => envInt("0", 1, 1, 10)).toThrow(/expected 1\.\.10/);
    expect(() => envInt("11", 1, 1, 10)).toThrow(/expected 1\.\.10/);
    expect(() => envInt("1.5", 1, 1, 10)).toThrow(/invalid integer/);
  });
});
