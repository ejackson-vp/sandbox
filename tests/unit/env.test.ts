import { describe, expect, it } from "vitest";
import { envBool, envInt, envTlsFiles } from "../../shared/src/env.js";

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

describe("TLS file sets", () => {
  const files = {
    CERT_FILE: "/tls/tls.crt",
    KEY_FILE: "/tls/tls.key",
    CA_FILE: "/tls/ca.crt",
  };

  it("returns undefined only when the whole set is unset", () => {
    expect(envTlsFiles({}, "RELAY_TLS")).toBeUndefined();
    expect(envTlsFiles({ RELAY_TLS_CERT_FILE: "" }, "RELAY_TLS")).toBeUndefined();
  });

  it("reads one prefix and ignores the others", () => {
    expect(
      envTlsFiles(
        {
          CONTROLLER_TLS_CERT_FILE: "/controller/tls.crt",
          CONTROLLER_TLS_KEY_FILE: "/controller/tls.key",
          CONTROLLER_TLS_CA_FILE: "/controller/ca.crt",
          TLS_CERT_FILE: files.CERT_FILE,
          TLS_KEY_FILE: files.KEY_FILE,
          TLS_CA_FILE: files.CA_FILE,
        },
        "CONTROLLER_TLS",
      ),
    ).toEqual({
      certFile: "/controller/tls.crt",
      keyFile: "/controller/tls.key",
      caFile: "/controller/ca.crt",
    });
  });

  it("refuses a partial set and names the variables by prefix", () => {
    expect(() => envTlsFiles({ TLS_CERT_FILE: files.CERT_FILE }, "TLS")).toThrow(
      "TLS_CERT_FILE, TLS_KEY_FILE and TLS_CA_FILE must be set together",
    );
    expect(() => envTlsFiles({ RELAY_TLS_KEY_FILE: files.KEY_FILE }, "RELAY_TLS")).toThrow(
      "RELAY_TLS_CERT_FILE, RELAY_TLS_KEY_FILE and RELAY_TLS_CA_FILE must be set together",
    );
  });
});
