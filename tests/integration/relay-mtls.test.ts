/**
 * End-to-end relay mTLS control path with the real Go guest (#23).
 *
 * Registration, the state probe and the request/response long-poll all travel
 * over the controller client certificate. Only the guest WebSocket remains on
 * the plaintext listener, using its existing bearer token.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GuestHarness } from "../helpers/guest.js";
import { makeTestPki, type TestPki } from "../helpers/tls.js";
import { testPort } from "./ports.js";

let pki: TestPki;
let guest: GuestHarness;

beforeAll(async () => {
  pki = makeTestPki();
  guest = new GuestHarness({
    port: testPort(18520),
    controlPort: testPort(18521),
    relayTls: { certFile: pki.serverCertFile, keyFile: pki.serverKeyFile, caFile: pki.caFile },
    relayClientTls: {
      certFile: pki.clientCertFile,
      keyFile: pki.clientKeyFile,
      caFile: pki.caFile,
    },
    leaseSeconds: 120,
  });
  await guest.start();
});

afterAll(async () => {
  await guest?.stop();
});

describe("relay control mTLS with a real guest", () => {
  it("registers, wakes and executes over the certificate-authenticated control path", async () => {
    // GuestHarness.start() already registered over mTLS and waited for the
    // guest hello to reach the registry through the relay's wake callback.
    const state = await guest.relayClient.state(guest.sessionId);
    expect(state.connected).toBe(true);
    expect(state.attestation?.sessionId).toBe(guest.sessionId);

    const result = await guest.exec(["bash", "-c", "echo mtls-ok"]);
    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe("mtls-ok");
  }, 30_000);

  it("rejects plaintext on the control port", async () => {
    await expect(fetch(`http://127.0.0.1:${testPort(18521)}/internal/register`, { method: "POST" })).rejects.toThrow();
  });
});
