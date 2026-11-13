/**
 * The full control-plane stack shared by the `api-*` integration suites.
 *
 * This was one `beforeAll` inside `api-flow.test.ts`. That file covered four
 * different jobs (the payment handshake, command execution, the session
 * lifecycle and startup configuration) and could not stay under the module
 * budget, so it is split by use case. The stack itself is the same in every
 * file: real x402 handshake against the mock facilitator, real controller,
 * Postgres store, relay and reconciler, the real guest process through
 * `LocalProvisioner`, and the real SDK. Only Kubernetes pod creation is
 * substituted; tests/security covers the real cluster.
 *
 * Each caller names its own database namespace and port offset. The files stay
 * independent: no suite reads another's rows, and a listener left behind by a
 * failed teardown cannot take the next file down with EADDRINUSE.
 */
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMockFacilitator,
  type MockFacilitatorHandle,
} from "../../../api/src/mock-facilitator.js";
import { createApp } from "../../../api/src/server.js";
import { loadConfig } from "../../../api/src/config.js";
import { ControllerClient } from "../../../api/src/controller-client.js";
import { createControlApi } from "../../../controller/src/control-api.js";
import { createRelay, type RelayServer } from "../../../controller/src/relay.js";
import { RelayClient } from "../../../controller/src/relay-client.js";
import { Reconciler } from "../../../controller/src/reconciler.js";
import type { PostgresStore } from "../../../controller/src/store/postgres/store.js";
import type { SessionRecord } from "../../../controller/src/store/models.js";
import type { Snapshotter } from "../../../controller/src/snapshotter.js";
import { LocalProvisioner } from "../../../controller/src/local-provisioner.js";
import { CapacityService } from "../../../controller/src/capacity/service.js";
import { loadControllerConfig } from "../../../controller/src/config.js";
import {
  generateBoxKeyPair,
  generateNonce,
  toBase64,
} from "../../../shared/src/entries/crypto.js";
import type { SessionStatus } from "../../../shared/src/entries/protocol.js";
import { FileSessionStore, SandboxClient } from "../../../sdk/src/index.js";
import {
  closeStore,
  countRows as countRowsIn,
  freshStore,
  testDatabaseUrl,
} from "../../helpers/test-store.js";
import { testPort } from "../ports.js";

const ADMIN = "integration-admin-token-0123456789";
const RELAY_ADMIN = "r".repeat(24);
const WAKE = "w".repeat(24);
const DEV_SEED = "qSgP+dPwGhb/58O0ZD/dSqCMovhhWNIQbT3MeTD35WY=";
const GUEST_BINARY = process.env.GUEST_BINARY ?? join(process.cwd(), "guest/bin/x402-guest");

/** Records what the reconciler asked of the checkpoint port. */
export class RecordingSnapshotter implements Snapshotter {
  readonly captured: string[] = [];
  readonly restored: string[] = [];
  readonly discarded: string[] = [];

  async capture(session: SessionRecord): Promise<void> {
    this.captured.push(session.id);
  }
  async restore(session: SessionRecord): Promise<void> {
    this.restored.push(session.id);
  }
  async discard(session: SessionRecord): Promise<void> {
    this.discarded.push(session.id);
  }
}

export interface HarnessOptions {
  /** Database namespace. Distinct per file so one suite cannot read another's rows. */
  namespace: string;
  /** Added to every fixed port, in the same spirit as `X402_TEST_PORT_BASE`. */
  portOffset?: number;
}

export interface CreateBody {
  tier: string;
  durationSeconds: number;
  clientPublicKey: string;
  clientNonce: string;
  [key: string]: unknown;
}

export interface Harness {
  readonly apiUrl: string;
  readonly controllerUrl: string;
  readonly facilitatorUrl: string;
  readonly client: SandboxClient;
  readonly store: PostgresStore;
  readonly provisioner: LocalProvisioner;
  readonly reconciler: Reconciler;
  readonly snapshotter: RecordingSnapshotter;
  readonly apiController: ControllerClient;
  readonly facilitator: MockFacilitatorHandle;
  /** Unpaid and paid creates against the running API. */
  postSession(body: unknown, header?: string): Promise<Response>;
  /** A create body carrying a fresh client key and nonce. */
  createBody(overrides?: Partial<CreateBody>): Promise<CreateBody>;
  /** Poll the status route until the predicate holds, or fail on timeout. */
  pollStatus(
    handle: { sessionId: string; capability: string },
    until: (status: SessionStatus) => boolean,
    timeoutMs?: number,
  ): Promise<SessionStatus>;
  /** `COUNT(*)` in this harness's database. */
  countRows(table: string): Promise<number>;
  stop(): Promise<void>;
}

function listen(app: http.RequestListener | http.Server, port: number): Promise<http.Server> {
  const server = http.createServer(app as http.RequestListener);
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Boot the whole stack for one test file. */
export async function startHarness(options: HarnessOptions): Promise<Harness> {
  const offset = options.portOffset ?? 0;
  const apiPort = testPort(13_300 + offset);
  const controllerPort = testPort(13_301 + offset);
  const facilitatorPort = testPort(13_302 + offset);
  const relayPort = testPort(18_455 + offset);
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const controllerUrl = `http://127.0.0.1:${controllerPort}`;
  const facilitatorUrl = `http://127.0.0.1:${facilitatorPort}`;
  const relayUrl = `http://127.0.0.1:${relayPort}`;

  const workDir = mkdtempSync(join(tmpdir(), "x402-session-it-"));
  const servers: http.Server[] = [];
  const running: {
    reconciler?: Reconciler;
    relay?: RelayServer;
    facilitator?: MockFacilitatorHandle;
    store?: PostgresStore;
  } = {};

  const stop = async (): Promise<void> => {
    running.reconciler?.stop();
    await running.relay?.close();
    for (const server of servers) await close(server).catch(() => undefined);
    running.facilitator?.close();
    await running.store?.close();
    await rm(workDir, { recursive: true, force: true });
  };

  const postSession = async (body: unknown, header?: string): Promise<Response> =>
    fetch(`${apiUrl}/v1/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(header ? { "PAYMENT-SIGNATURE": header } : {}),
      },
      body: JSON.stringify(body),
    });

  const createBody = async (overrides: Partial<CreateBody> = {}): Promise<CreateBody> => {
    const keys = await generateBoxKeyPair();
    return {
      tier: "custom",
      durationSeconds: 60,
      clientPublicKey: toBase64(keys.publicKey),
      clientNonce: toBase64(await generateNonce()),
      ...overrides,
    };
  };

  const pollStatus = async (
    handle: { sessionId: string; capability: string },
    until: (status: SessionStatus) => boolean,
    timeoutMs = 45_000,
  ): Promise<SessionStatus> => {
    const deadline = Date.now() + timeoutMs;
    let last: SessionStatus | undefined;
    while (Date.now() < deadline) {
      const res = await fetch(`${apiUrl}/v1/sessions/${handle.sessionId}`, {
        headers: { "x-sandbox-capability": handle.capability },
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      last = (await res.json()) as SessionStatus;
      if (until(last)) return last;
      await sleep(150);
    }
    throw new Error(`timeout; last state ${last?.state}`);
  };

  try {
    const facilitator = await createMockFacilitator({ dbPath: join(workDir, "facilitator.db") });
    running.facilitator = facilitator;
    servers.push(await listen(facilitator.app, facilitatorPort));

    const relay = createRelay({ adminToken: RELAY_ADMIN, responseTtlMs: 120_000 });
    running.relay = relay;
    await new Promise<void>((r) => relay.server.listen(relayPort, "127.0.0.1", () => r()));

    const relayClient = new RelayClient({ baseUrl: relayUrl, adminToken: RELAY_ADMIN });

    // The tracked store is process-wide and keyed to the first namespace opened
    // in this worker, so a store leaked by an earlier file must not be adopted
    // here: it would write to the other file's database.
    await closeStore();
    const store = await freshStore({ namespace: options.namespace });
    running.store = store;

    const controllerCfg = loadControllerConfig({
      ADMIN_TOKEN: ADMIN,
      ROLE: "all",
      EXECUTION_MODE: "dev",
      ALLOW_INSECURE_DEV: "true",
      KUBERNETES_ENABLED: "false",
      DATABASE_URL: testDatabaseUrl(options.namespace),
      RELAY_URL: relayUrl,
      RELAY_ADMIN_TOKEN: RELAY_ADMIN,
      WAKE_TOKEN: WAKE,
      PROXY_TOKEN_SECRET: "proxy-secret-0123456789",
      GUEST_IMAGE: "x402-sandbox/guest:dev",
      RECONCILE_INTERVAL_MS: "100",
      RELAY_RESPONSE_WAIT_MS: "30000",
      ALLOW_CUSTOM_DURATIONS: "true",
      // The durable create budget (#48) is a production ceiling; these suites use
      // one ephemeral payer for dozens of sequential creates, so give it headroom
      // rather than tuning the test around the default window.
      PAYER_CREATES_PER_WINDOW: "1000",
      PAYER_CONCURRENT_SESSIONS: "0",
      GLOBAL_CREATES_PER_WINDOW: "10000",
    });

    const provisioner = new LocalProvisioner({
      binary: GUEST_BINARY,
      relayHost: "127.0.0.1",
      relayPort,
      proxyHost: "127.0.0.1",
      proxyPort: 3128,
      workRoot: join(workDir, "sandboxes"),
    });

    const capacity = new CapacityService({ cfg: controllerCfg, store, provisioner });

    let suspendFn: ((id: string) => Promise<void>) | undefined;
    let resumeFn: ((id: string) => Promise<void>) | undefined;
    servers.push(
      await listen(
        createControlApi({
          cfg: controllerCfg,
          store,
          relay: relayClient,
          provisioner,
          capacity,
          suspend: (id) => {
            if (!suspendFn) return Promise.reject(new Error("reconciler not started"));
            return suspendFn(id);
          },
          resume: (id) => {
            if (!resumeFn) return Promise.reject(new Error("reconciler not started"));
            return resumeFn(id);
          },
        }),
        controllerPort,
      ),
    );

    const snapshotter = new RecordingSnapshotter();
    const reconciler = new Reconciler({
      cfg: controllerCfg,
      store,
      provisioner,
      relay: relayClient,
      capacity,
      snapshotter,
    });
    running.reconciler = reconciler;
    suspendFn = (id) => reconciler.suspendSession(id);
    resumeFn = (id) => reconciler.resumeSession(id);
    reconciler.start();

    const apiCfg = loadConfig({
      PORT: String(apiPort),
      PAYMENT_MODE: "mock",
      FACILITATOR_URL: facilitatorUrl,
      CONTROLLER_URL: controllerUrl,
      CONTROLLER_ADMIN_TOKEN: ADMIN,
      CAPABILITY_SECRET: "test-only-capability-secret",
      PUBLIC_BASE_URL: apiUrl,
      ALLOW_INSECURE_DEV: "true",
      PAYMENT_INTENT_STALE_MS: "1000",
      ALLOW_CUSTOM_DURATIONS: "true",
    });
    const apiController = new ControllerClient(apiCfg.controllerUrl, ADMIN);
    servers.push(
      await listen(await createApp({ config: apiCfg, controller: apiController }), apiPort),
    );

    process.env.DEV_ATTESTATION_KEY = DEV_SEED;
    process.env.DEV_ATTESTATION_KEY_ID = "x402-dev-attestation-key-INSECURE-DEV-ONLY";

    const client = new SandboxClient({
      apiUrl,
      paymentMode: "mock",
      allowInsecureDev: true,
      store: new FileSessionStore(join(workDir, "sessions")),
    });

    return {
      apiUrl,
      controllerUrl,
      facilitatorUrl,
      client,
      store,
      provisioner,
      reconciler,
      snapshotter,
      apiController,
      facilitator,
      postSession,
      createBody,
      pollStatus,
      countRows: (table: string) => countRowsIn(table, options.namespace),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
