/** Manual protocol harness for debugging (not part of the test suite). */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRelay } from "../controller/src/relay.js";
import { RelayClient } from "../controller/src/relay-client.js";
import {
  fromBase64,
  generateBoxKeyPair,
  generateNonce,
  openSealedJson,
  sealJsonTo,
  toBase64,
  type ExecutePlaintext,
  type ResultPlaintext,
} from "../shared/src/index.js";

const PORT = 18999;
const ADMIN = "admin-token-0123456789abcdef";
const sessionId = "sbx_0123456789abcdef01234567";
const guestToken = "guest-token-manual-0123456789";

const relay = createRelay({ adminToken: ADMIN });
await new Promise<void>((r) => relay.server.listen(PORT, "127.0.0.1", () => r()));
const rc = new RelayClient({ baseUrl: `http://127.0.0.1:${PORT}`, adminToken: ADMIN });

const keys = await generateBoxKeyPair();
const nonce = toBase64(await generateNonce());
await rc.register(sessionId, createHash("sha256").update(guestToken).digest("hex"), 120000);

const guest = spawn("guest/bin/x402-guest", ["run"], {
  env: {
    PATH: process.env.PATH,
    SESSION_ID: sessionId,
    RELAY_URL: `ws://127.0.0.1:${PORT}/guest?session=${sessionId}&token=${guestToken}`,
    CLIENT_PUBLIC_KEY: toBase64(keys.publicKey),
    CLIENT_NONCE: nonce,
    EXEC_DURATION_SECONDS: "20",
    EXECUTION_MODE: "dev",
    RUNTIME_CLASS: "x402-sandbox",
    GUEST_IMAGE_DIGEST: "sha256:test",
    MAX_OUTPUT_BYTES: "65536",
    DEV_ATTESTATION_KEY: "qSgP+dPwGhb/58O0ZD/dSqCMovhhWNIQbT3MeTD35WY=",
    PROXY_TOKEN: "",
    EGRESS_PROXY_URL: "",
    LOG_LEVEL: "debug",
    X402_SANDBOX_DIR: process.env.X402_SANDBOX_DIR ?? "/tmp/x402-sandbox-debug",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
guest.on("exit", (code, sig) => console.log("guest exited", code, sig));

for (let i = 0; i < 100; i++) {
  const s = await rc.state(sessionId);
  if (s.connected && s.attestation) {
    console.log("guest ready:", s.attestation.evidenceType, s.attestation.guestPublicKey.slice(0, 12));
    const env = await sealJsonTo(fromBase64(s.attestation.guestPublicKey), {
      v: 1,
      sessionId,
      clientNonce: nonce,
      language: "python3",
      code: "print('hi from guest')\n",
    } satisfies ExecutePlaintext);
    console.log("delivering", env.length);
    await rc.deliver(sessionId, env, Date.now() + 20000);
    break;
  }
  await new Promise((r) => setTimeout(r, 200));
}

const out = await rc.result(sessionId, 15000);
console.log("result:", out.envelope ? "received" : "none", out.error);
if (out.envelope) {
  const decoded = await openSealedJson<ResultPlaintext>(out.envelope, keys.publicKey, keys.privateKey);
  console.log(decoded);
}
guest.kill("SIGKILL");
await relay.close();
