/**
 * The paid create path: challenge, settlement, entitlement and refunds.
 *
 * Split out of api-flow.test.ts. These cases decide whether money moved exactly
 * once, so they are read together: the 402 challenge per tier, receipt binding
 * and client key proof, idempotent replay, recovery on both sides of
 * settlement, the ledger refund, and admission refusing an oversized request
 * before any payment. Command execution, the data plane and the session
 * lifecycle live in the sibling api-* files and share this stack through
 * support/api-harness.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { ControllerError } from "../../api/src/controller-client.js";
import type { ControllerClient } from "../../api/src/controller-client.js";
import type { MockFacilitatorHandle } from "../../api/src/mock-facilitator.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import type { LocalProvisioner } from "../../controller/src/local-provisioner.js";
import type { Reconciler } from "../../controller/src/reconciler.js";
import { clientCommitmentMessage } from "../../shared/src/entries/crypto.js";
import { paymentKey } from "../../shared/src/entries/payment.js";
import type { SessionStatus } from "../../shared/src/entries/protocol.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { SandboxClient } from "../../sdk/src/index.js";
import { createSessionPayment } from "../helpers/x402.js";
import { startHarness, type Harness } from "./support/api-harness.js";

let harness: Harness;
let apiUrl: string;
let controllerUrl: string;
let facilitatorUrl: string;
let facilitator: MockFacilitatorHandle;
let store: PostgresStore;
let client: SandboxClient;
let apiController: ControllerClient;
let provisioner: LocalProvisioner;
let reconciler: Reconciler;
let postSession: Harness["postSession"];
let createBody: Harness["createBody"];
let pollStatus: Harness["pollStatus"];
let countRows: Harness["countRows"];

beforeAll(async () => {
  harness = await startHarness({ namespace: "integration-api-payments", portOffset: 0 });
  apiUrl = harness.apiUrl;
  controllerUrl = harness.controllerUrl;
  facilitatorUrl = harness.facilitatorUrl;
  facilitator = harness.facilitator;
  store = harness.store;
  client = harness.client;
  apiController = harness.apiController;
  provisioner = harness.provisioner;
  reconciler = harness.reconciler;
  postSession = harness.postSession;
  createBody = harness.createBody;
  pollStatus = harness.pollStatus;
  countRows = harness.countRows;
});

afterAll(async () => {
  await harness.stop();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readiness", () => {
  it("reports ready for the API and controller before serving creates", async () => {
    const apiReady = await fetch(`${apiUrl}/readyz`);
    expect(apiReady.status).toBe(200);
    expect(await apiReady.json()).toMatchObject({ ok: true, components: { controller: { ok: true } } });

    const controllerReady = await fetch(`${controllerUrl}/internal/readyz`);
    expect(controllerReady.status).toBe(200);
    const body = (await controllerReady.json()) as {
      ok: boolean;
      components: Record<string, { ok: boolean }>;
    };
    expect(body.ok).toBe(true);
    expect(body.components.store).toMatchObject({ ok: true });
    expect(body.components.relay).toMatchObject({ ok: true });
    expect(body.components.provisioner).toMatchObject({ ok: true });
  });
});

describe("payments and entitlements", () => {
  it("returns a 402 challenge priced per tier", async () => {
    const body = await createBody({ tier: "extended", durationSeconds: undefined });
    const res = await postSession(body);
    expect(res.status).toBe(402);
    const header = res.headers.get("payment-required");
    expect(header).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts[0].amount).toBe("100000"); // $0.10
    expect(decoded.accepts[0].network).toBe("mock:local");
    expect(await countRows("sessions")).toBe(0);
  });

  it("rejects a tampered payment", async () => {
    const body = await createBody();
    const { header, body: signedBody } = await createSessionPayment(apiUrl, body);
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    decoded.payload.authorization.value = "1";
    const tampered = Buffer.from(JSON.stringify(decoded)).toString("base64");
    const res = await postSession(signedBody, tampered);
    // Tampering changes the payment key, so the wallet's commitment signature
    // no longer covers this receipt. Rejected before any settlement.
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("client_proof_invalid");
    expect(await countRows("sessions")).toBe(0);
  });

  it("rejects plaintext command fields", async () => {
    const res = await fetch(`${apiUrl}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(await createBody()), command: ["echo", "hi"] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("plaintext_not_accepted");
  });

  it("rejects a duration that does not match a fixed tier", async () => {
    const body = await createBody({ tier: "standard", durationSeconds: 61 });
    const res = await postSession(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("tier_duration_mismatch");
  });

  it("creates exactly one session for one payment and replays idempotently", async () => {
    const body = await createBody();
    const { header, body: signedBody } = await createSessionPayment(apiUrl, body);
    const first = await postSession(signedBody, header);
    expect(first.status).toBe(201);
    const created = (await first.json()) as { sessionId: string; capability: string };
    const before = await countRows("sessions");

    const replay = await postSession(signedBody, header);
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { sessionId: string; capability: string };
    expect(replayBody.sessionId).toBe(created.sessionId);
    expect(replayBody.capability).toBe(created.capability);
    expect(await countRows("sessions")).toBe(before);
  });

  it("returns the session view with the create and skips the post-create getSession", async () => {
    const body = await createBody();
    const { header, body: signedBody } = await createSessionPayment(apiUrl, body);
    const lookup = vi.spyOn(apiController, "getSession");
    try {
      const res = await postSession(signedBody, header);
      expect(res.status).toBe(201);
      const created = (await res.json()) as {
        sessionId: string;
        capability: string;
        state: SessionStatus["state"];
        limits: SessionStatus["limits"];
        session?: SessionStatus;
      };
      // The view came from the completion response, not a second controller call.
      expect(lookup).not.toHaveBeenCalled();
      expect(created.session).toBeDefined();
      expect(created.session).toMatchObject({
        sessionId: created.sessionId,
        state: created.state,
        limits: created.limits,
        clientNonce: body.clientNonce,
        busy: false,
      });
      // PAID has no lease yet, so the embedded view agrees with the status route.
      expect(created.session?.remainingSeconds).toBe(0);

      const statusRes = await fetch(`${apiUrl}/v1/sessions/${created.sessionId}`, {
        headers: { "x-sandbox-capability": created.capability },
      });
      expect(statusRes.status).toBe(200);
      const status = (await statusRes.json()) as SessionStatus;
      expect(status).toMatchObject({
        sessionId: created.session?.sessionId,
        tier: created.session?.tier,
        durationSeconds: created.session?.durationSeconds,
        createdAt: created.session?.createdAt,
        limits: created.session?.limits,
      });
      expect(status.payment.amount).toBe(created.session?.payment.amount);
    } finally {
      lookup.mockRestore();
    }
  });

  it("builds the SDK handle from the embedded create view", async () => {
    const handle = await client.createSession({
      tier: "custom",
      durationSeconds: 30,
      cpuMillis: 500,
      memoryMiB: 512,
      diskMiB: 256,
    });
    try {
      expect(handle.status).toMatchObject({
        sessionId: handle.sessionId,
        state: "PAID",
        clientNonce: handle.clientNonce,
        busy: false,
      });
      expect(handle.status?.clientNonce).toBe(handle.clientNonce);
      expect(Date.parse(handle.status!.createdAt)).toBeGreaterThan(Date.now() - 60_000);
      expect(handle.status?.payment.priceUsd).toMatch(/^\$/);
      // The embedded view is the server's view, not a locally invented one.
      expect(handle.status?.tier).toBe("custom");
    } finally {
      await client.destroy(handle).catch(() => undefined);
    }
  }, 20_000);

  it("does not let a receipt holder bind the session to their own client key", async () => {
    // B has A's PAYMENT-SIGNATURE but not A's wallet. B tries to bind the
    // session to B's client key before A submits.
    const bodyA = await createBody();
    const { header, challenge, challengeNonce, body: signedA } = await createSessionPayment(apiUrl, bodyA);
    const bodyB = await createBody();
    const b = privateKeyToAccount(generatePrivateKey());
    const payload = decodePaymentSignatureHeader(header);
    const bSignature = await b.signMessage({
      message: clientCommitmentMessage({
        paymentKey: paymentKey(payload),
        clientPublicKey: bodyB.clientPublicKey,
        clientNonce: bodyB.clientNonce,
        challengeNonce,
      }),
    });

    const before = await countRows("sessions");
    const hijack = await postSession({ ...bodyB, challengeNonce, clientSignature: bSignature }, header);
    expect(hijack.status).toBe(401);
    expect(((await hijack.json()) as { error: string }).error).toBe("client_proof_invalid");
    expect(await countRows("sessions")).toBe(before);
    expect(challenge.requirement.amount).toBeTruthy();

    // A's own request still works: the hijack attempt consumed nothing.
    const created = await postSession(signedA, header);
    expect(created.status).toBe(201);
    expect(await countRows("sessions")).toBe(before + 1);
  });

  it("does not return a capability to a client that only holds the receipt", async () => {
    // A pays and owns a live session. B steals the header and asks for the
    // capability with its own client key, then with A's key but no proof.
    const bodyA = await createBody();
    const { header, challengeNonce, body: signedA, account: payer } = await createSessionPayment(apiUrl, bodyA);
    const first = await postSession(signedA, header);
    expect(first.status).toBe(201);
    const created = (await first.json()) as { sessionId: string; capability: string };

    const bodyB = await createBody();
    const b = privateKeyToAccount(generatePrivateKey());
    const payload = decodePaymentSignatureHeader(header);
    const bSignature = await b.signMessage({
      message: clientCommitmentMessage({
        paymentKey: paymentKey(payload),
        clientPublicKey: bodyB.clientPublicKey,
        clientNonce: bodyB.clientNonce,
        challengeNonce,
      }),
    });

    // B's own wallet cannot sign A's payment: rejected before any intent work.
    const bAttempt = await postSession({ ...bodyB, challengeNonce, clientSignature: bSignature }, header);
    expect(bAttempt.status).toBe(401);
    expect(((await bAttempt.json()) as { error: string }).error).toBe("client_proof_invalid");

    // Even the payer's wallet, signing a *different* client key for the same
    // receipt, is a different spec: no capability is minted for it.
    const bodyA2 = await createBody();
    const aDifferentKeySignature = await payer.signMessage({
      message: clientCommitmentMessage({
        paymentKey: paymentKey(payload),
        clientPublicKey: bodyA2.clientPublicKey,
        clientNonce: bodyA2.clientNonce,
        challengeNonce,
      }),
    });
    const withDifferentKey = await postSession(
      { ...bodyA2, challengeNonce, clientSignature: aDifferentKeySignature },
      header,
    );
    expect(withDifferentKey.status).toBe(409);
    const rejected = (await withDifferentKey.json()) as { error: string; capability?: string };
    expect(rejected.capability).toBeUndefined();
    expect(["spec_mismatch", "capacity_unavailable"]).toContain(rejected.error);

    // Same client key but no proof of possession.
    const withoutProof = await postSession(bodyA, header);
    expect(withoutProof.status).toBe(401);
    expect(((await withoutProof.json()) as { error: string }).error).toBe("client_proof_required");

    // The rightful owner can still present the capability.
    const status = await fetch(`${apiUrl}/v1/sessions/${created.sessionId}`, {
      headers: { "x-sandbox-capability": created.capability },
    });
    expect(status.status).toBe(200);
  });

  it("cannot create multiple sessions under concurrent retries", async () => {
    const body = await createBody();
    const { header, body: signedBody } = await createSessionPayment(apiUrl, body);
    const before = await countRows("sessions");
    const results = await Promise.all(Array.from({ length: 6 }, () => postSession(signedBody, header)));
    const created = results.filter((r) => r.status === 201).length;
    const idempotent = results.filter((r) => r.status === 200).length;
    const rejected = results.filter((r) => r.status === 409).length;
    expect(created).toBe(1);
    expect(created + idempotent).toBeGreaterThanOrEqual(1);
    expect(created + idempotent + rejected).toBe(6);
    expect(await countRows("sessions")).toBe(before + 1);
  });

  it("does not create a session when settlement fails", async () => {
    facilitator.setFailSettle(true);
    try {
      const body = await createBody();
      const { header, body: signedBody } = await createSessionPayment(apiUrl, body);
      const before = await countRows("sessions");
      const res = await postSession(signedBody, header);
      expect(res.status).toBe(402);
      expect(await countRows("sessions")).toBe(before);
    } finally {
      facilitator.setFailSettle(false);
    }
  });

  it("recovers an entitlement when the payment settled before the API crashed", async () => {
    const body = await createBody();
    const { header, challenge, body: signedBody } = await createSessionPayment(apiUrl, body);
    // Settle directly with the facilitator, simulating a crash after settlement
    // but before the entitlement was durable.
    const payload = decodePaymentSignatureHeader(header);
    const settle = await fetch(`${facilitatorUrl}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: challenge.requirement }),
    });
    expect(((await settle.json()) as { success: boolean }).success).toBe(true);

    const before = await countRows("sessions");
    const res = await postSession(signedBody, header);
    expect(res.status).toBe(201);
    expect(await countRows("sessions")).toBe(before + 1);
  });

  it("recovers when the controller crashes after settlement but before entitlement", async () => {
    const body = await createBody();
    const { header, body: signedBody } = await createSessionPayment(apiUrl, body);
    const before = await countRows("sessions");
    const paymentsBefore = await countRows("payments");
    const original = apiController.completeIntent.bind(apiController);
    (apiController as unknown as { completeIntent: typeof apiController.completeIntent }).completeIntent = async () => {
      throw new ControllerError(503, "injected_crash", "simulated controller crash after settlement");
    };
    try {
      const first = await postSession(signedBody, header);
      expect(first.status).toBe(503);
      expect(await countRows("sessions")).toBe(before);
    } finally {
      (apiController as unknown as { completeIntent: typeof apiController.completeIntent }).completeIntent = original;
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const retry = await postSession(signedBody, header);
    expect(retry.status).toBe(201);
    expect(await countRows("sessions")).toBe(before + 1);
    // Exactly-once accounting: the retry recovered the settled payment rather
    // than charging a second time.
    expect(await countRows("payments")).toBe(paymentsBefore + 1);
    const created = (await retry.json()) as { sessionId: string; capability: string };

    // The same client can recover the same capability, and no second charge is
    // recorded.
    const recovered = await postSession(signedBody, header);
    expect(recovered.status).toBe(200);
    expect(((await recovered.json()) as { capability: string }).capability).toBe(created.capability);
    expect(await countRows("payments")).toBe(paymentsBefore + 1);

    await fetch(`${apiUrl}/v1/sessions/${created.sessionId}`, {
      method: "DELETE",
      headers: { "x-sandbox-capability": created.capability },
    }).catch(() => undefined);
  }, 30_000);

  it("adopts a Pod created just before the controller crashed", async () => {
    const original = provisioner.createPod.bind(provisioner);
    let failOnce = true;
    provisioner.createPod = async (spec) => {
      const result = await original(spec);
      if (failOnce) {
        failOnce = false;
        throw new Error("simulated controller crash after Pod creation");
      }
      return result;
    };
    try {
      const handle = await client.createSession({ tier: "custom", durationSeconds: 60, cpuMillis: 500, memoryMiB: 512, diskMiB: 256 });
      const ready = await client.waitForReady(handle, 20_000);
      expect(ready.state).toBe("READY");
      await client.destroy(handle);
    } finally {
      provisioner.createPod = original;
    }
  }, 30_000);

  it("scopes capabilities to a single session", async () => {
    const a = await client.createSession({ tier: "custom", durationSeconds: 30 });
    const b = await client.createSession({ tier: "custom", durationSeconds: 30 });
    const res = await fetch(`${apiUrl}/v1/sessions/${b.sessionId}`, {
      headers: { "x-sandbox-capability": a.capability },
    });
    expect(res.status).toBe(404);
    await client.destroy(a).catch(() => undefined);
    await client.destroy(b).catch(() => undefined);
  });
});

describe("payment ledger and refunds", () => {
  it("refunds a paid session that never becomes ready", async () => {
    const original = provisioner.createPod.bind(provisioner);
    provisioner.createPod = async () => {
      throw new Error("simulated provisioning failure before READY");
    };
    try {
      const handle = await client.createSession({ tier: "custom", durationSeconds: 60 });
      expect((await store.getLedgerBySession(handle.sessionId))?.status).toBe("SETTLED");
      await store.requestTermination(handle.sessionId, "failure:simulated_provisioning");
      reconciler.wake();
      const terminal = await pollStatus(
        handle,
        (status) => status.state === "FAILED" || status.state === "EXPIRED" || status.state === "DESTROYED",
        15_000,
      );
      expect(terminal.state).toBe("FAILED");
      const ledger = await store.getLedgerBySession(handle.sessionId);
      expect(ledger).toMatchObject({
        status: "REFUNDED",
        sessionId: handle.sessionId,
      });
      expect(ledger?.refundTransaction).toMatch(/^mock:refund:/);
    } finally {
      provisioner.createPod = original;
    }
  }, 60_000);

  it("does not refund a session that reached READY", async () => {
    const handle = await client.createSession({ tier: "custom", durationSeconds: 60 });
    await client.waitForReady(handle);
    const destroyed = await client.destroy(handle, 30_000);
    expect(destroyed?.state).toBe("DESTROYED");
    expect((await store.getLedgerBySession(handle.sessionId))?.status).toBe("SETTLED");
  }, 60_000);
});

describe("capacity admission", () => {
  it("rejects an oversized session before payment", async () => {
    await expect(
      client.createSession({
        tier: "custom",
        durationSeconds: 60,
        cpuMillis: 1000,
        memoryMiB: 8192,
        diskMiB: 1024,
        baselineCpuMillis: 500,
        baselineMemoryMiB: 4096,
      }),
    ).rejects.toMatchObject({ code: "capacity_unavailable" });
  }, 60_000);
});
