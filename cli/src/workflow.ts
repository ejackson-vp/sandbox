/**
 * The customer workflow, shared by the interactive CLI and the agent example.
 *
 * 1. create (paid) sandbox            -> capability + session id
 * 2. poll until READY                 -> attestation evidence
 * 3. verify evidence independently    -> refuse simulated unless opted in
 * 4. encrypt code to the guest key    -> opaque envelope
 * 5. POST execute                     -> one execution
 * 6. fetch result, decrypt locally    -> plaintext only on the client
 */
import {
  fromBase64,
  generateBoxKeyPair,
  generateNonce,
  openSealedJson,
  sealJsonTo,
  toBase64,
  verifyAttestation,
  type AttestationEnvelope,
  type AttestationPolicy,
  type CreateSandboxRequest,
  type CreateSandboxResponse,
  type ExecutePlaintext,
  type ResultPlaintext,
  type SandboxStatus,
  isTerminal,
} from "@x402s/shared";
import type { PaidResponse, Payer } from "./payment.js";

export interface RunOptions {
  apiUrl: string;
  code: string;
  durationSeconds: number;
  allowInsecureDev: boolean;
  requireHardware: boolean;
  expectedMeasurement?: string;
  keepSandbox: boolean;
  json: boolean;
  payer: Payer;
  /** Print a line (human output mode). */
  say: (line: string) => void;
  /** Progress-only diagnostics, suppressed in JSON mode. */
  note: (line: string) => void;
  /** Called once the sandbox is READY and attestation has been verified. */
  onReady?: (info: { sandboxId: string; capability: string; status: SandboxStatus }) => Promise<void> | void;
}

export interface RunOutcome {
  sandboxId: string;
  state: string;
  result?: ResultPlaintext;
  attestation?: AttestationEnvelope;
  attestationVerified: boolean;
  payment: { priceUsd: string; mode: string; network: string; payer: string; transaction?: string };
  exitCode: number;
  error?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(40_000),
  });
}

export async function runWorkflow(opts: RunOptions): Promise<RunOutcome> {
  const base = opts.apiUrl.replace(/\/$/, "");
  const keyPair = await generateBoxKeyPair();
  const clientNonce = toBase64(await generateNonce());

  const createBody: CreateSandboxRequest = {
    durationSeconds: opts.durationSeconds,
    clientPublicKey: toBase64(keyPair.publicKey),
    clientNonce,
    language: "python3",
  };

  const paid: PaidResponse = await opts.payer.createSandbox(base, createBody);
  if (paid.paymentError) {
    return failure("", `payment rejected: ${paid.paymentError}`, paid);
  }
  if (!paid.response.ok) {
    const text = await paid.response.text().catch(() => "");
    return failure("", `sandbox creation failed (${paid.response.status}): ${text.slice(0, 300)}`, paid);
  }

  const created = (await paid.response.json()) as CreateSandboxResponse;
  opts.say(`Price: ${paid.priceUsd} (${paid.mode} payment)`);
  opts.say("Payment: accepted");
  opts.say("Sandbox: provisioning");

  const auth = { "x-sandbox-capability": created.capability };
  const statusUrl = `${base}/v1/sandboxes/${created.sandboxId}`;

  let status: SandboxStatus | undefined;
  const provisionDeadline = Date.now() + 120_000;
  while (Date.now() < provisionDeadline) {
    const res = await api(statusUrl, { headers: auth });
    if (!res.ok) {
      return failure(created.sandboxId, `status request failed (${res.status})`, paid);
    }
    status = (await res.json()) as SandboxStatus;
    if (status.state === "READY" || isTerminal(status.state)) break;
    await sleep(300);
  }
  if (!status) return failure(created.sandboxId, "no status received", paid);

  if (status.state !== "READY") {
    return failure(
      created.sandboxId,
      `sandbox did not become ready (state=${status.state}${status.failure ? `: ${status.failure.code}` : ""})`,
      paid,
    );
  }

  /* ---------------- attestation ---------------- */
  const evidence = status.attestation;
  if (!evidence || !status.guestPublicKey) {
    return failure(created.sandboxId, "READY sandbox did not provide attestation evidence", paid);
  }

  const mode = status.executionMode ?? "dev";
  const policy: AttestationPolicy = {
    mode: opts.requireHardware ? "confidential" : mode,
    allowInsecureDev: opts.allowInsecureDev && mode !== "confidential",
    expectedSessionId: created.sandboxId,
    expectedClientNonce: clientNonce,
    expectedClientPublicKey: toBase64(keyPair.publicKey),
    ...(opts.expectedMeasurement ? { allowedMeasurements: [opts.expectedMeasurement] } : {}),
  };
  const verdict = verifyAttestation(evidence, policy);
  if (!verdict.ok) {
    return failure(created.sandboxId, `attestation rejected: ${verdict.code} (${verdict.message})`, paid);
  }

  opts.say(
    verdict.hardwareBacked
      ? `Attestation: HARDWARE-VERIFIED (${verdict.evidenceType})`
      : `Attestation: INSECURE_DEV_ONLY (${verdict.evidenceType})`,
  );
  for (const warning of verdict.warnings) opts.note(`  ! ${warning}`);
  opts.note(`  measurement: ${verdict.guestMeasurement}`);
  if (evidence.claims?.kernelRelease) opts.note(`  guest kernel: ${evidence.claims.kernelRelease}`);
  opts.say("Sandbox: ready");

  if (opts.onReady) {
    await opts.onReady({ sandboxId: created.sandboxId, capability: created.capability, status });
  }

  /* ---------------- encrypt + execute ---------------- */
  const guestKey = fromBase64(status.guestPublicKey);
  if (guestKey.length !== 32) {
    return failure(created.sandboxId, "guest public key has invalid length", paid);
  }
  const plaintext: ExecutePlaintext = {
    v: 1,
    sessionId: created.sandboxId,
    clientNonce,
    language: "python3",
    code: opts.code,
  };
  const envelope = await sealJsonTo(guestKey, plaintext);

  opts.say("Uploading encrypted payload...");
  const execRes = await api(`${statusUrl}/execute`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ envelope }),
  });
  if (!execRes.ok) {
    const body = await execRes.text().catch(() => "");
    return failure(created.sandboxId, `execute rejected (${execRes.status}): ${body.slice(0, 300)}`, paid);
  }
  opts.say("Executing...");

  /* ---------------- result ---------------- */
  const resultDeadline = Date.now() + (opts.durationSeconds + 60) * 1000;
  let result: ResultPlaintext | undefined;
  let lastState: string = "RUNNING";
  while (Date.now() < resultDeadline) {
    const res = await api(`${statusUrl}/result`, { headers: auth });
    const body = (await res.json().catch(() => ({}))) as { state?: string; envelope?: string; error?: string };
    lastState = body.state ?? lastState;
    if (body.envelope) {
      try {
        const decrypted = await openSealedJson<ResultPlaintext>(body.envelope, keyPair.publicKey, keyPair.privateKey);
        if (decrypted.v !== 1 || decrypted.sessionId !== created.sandboxId || decrypted.clientNonce !== clientNonce) {
          return failure(created.sandboxId, "result envelope failed session binding check", paid);
        }
        result = decrypted;
      } catch {
        return failure(created.sandboxId, "result could not be decrypted with the client key", paid);
      }
      break;
    }
    if (lastState === "EXPIRED" || lastState === "FAILED" || lastState === "DESTROYED") break;
    await sleep(400);
  }

  if (!result) {
    return {
      sandboxId: created.sandboxId,
      state: lastState,
      attestation: evidence,
      attestationVerified: true,
      payment: {
        priceUsd: paid.priceUsd,
        mode: paid.mode,
        network: paid.network,
        payer: paid.payer,
      },
      exitCode: 124,
      error: `no result (state=${lastState})`,
    };
  }

  /* ---------------- destroy ---------------- */
  let finalState = "DESTROYED";
  if (!opts.keepSandbox) {
    await api(statusUrl, { method: "DELETE", headers: auth }).catch(() => undefined);
    for (let i = 0; i < 40; i++) {
      const res = await api(statusUrl, { headers: auth }).catch(() => undefined);
      if (res?.ok) {
        const s = (await res.json()) as SandboxStatus;
        finalState = s.state;
        if (s.state === "DESTROYED") break;
      }
      await sleep(250);
    }
  } else {
    finalState = lastState;
  }

  return {
    sandboxId: created.sandboxId,
    state: finalState,
    result,
    attestation: evidence,
    attestationVerified: true,
    payment: {
      priceUsd: paid.priceUsd,
      mode: paid.mode,
      network: paid.network,
      payer: paid.payer,
    },
    exitCode: result.exitCode,
  };
}

function failure(sandboxId: string, error: string, paid: PaidResponse): RunOutcome {
  return {
    sandboxId,
    state: "FAILED",
    attestationVerified: false,
    payment: {
      priceUsd: paid.priceUsd,
      mode: paid.mode,
      network: paid.network,
      payer: paid.payer,
    },
    exitCode: 1,
    error,
  };
}
