/**
 * Structural guardrail: keep modules reviewable.
 *
 * This is intentionally a blunt line-count check, not a style linter. It is a
 * backstop against the god files this refactor removed, and against the god
 * functions it left behind. It ratchets file length and, one level down,
 * function length. The real rules live in docs/architecture-principles.md.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, posix, relative } from "node:path";
import { functionSpans } from "./function-spans.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
// Ratchet: 550 is the budget; the ceiling is still 650 because six modules sit
// above it. The two controller modules this comment used to name,
// controller/src/provisioning.ts and controller/src/reconciler.ts, are split.
// What is left over 550: cli/src/commands.ts, tests/unit/effects.test.ts,
// guest/supervisor.go, controller/src/relay/registry.ts,
// tests/integration/relay-reconnect.test.ts and scripts/control-faults.ts.
// Lower to 550 when the guard prints nothing; never raise it again.
const MAX_LINES = 650;

/**
 * The size scan walks the repo from the root, because an include list is an
 * invitation to move a file just outside it: `verification/`, `site/`,
 * `examples/` and the repo root were all uncounted while ROOTS was an
 * allowlist. Only generated directories are skipped; nothing tracked lives in
 * them, and walking node_modules would take a minute.
 */
const EXCLUDED_DIRS = new Set([
  ".git",
  ".tmp-sandbox",
  "__pycache__",
  "artifacts",
  "bin",
  "coverage",
  "dist",
  "node_modules",
  // Stryker copies the project into .stryker-tmp/ and writes its HTML report to
  // reports/. Both are generated, neither is tracked, and walking the sandbox
  // copy would count every file twice.
  ".stryker-tmp",
  "reports",
]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".go"]);

/**
 * The over-budget files, and the exact line count each one is at today.
 *
 * This is a ratchet that only shrinks. A file in here may not grow: the guard
 * fails and the pinned number may only go down. It fails on a shrink too, so
 * the number is lowered in the same change rather than drifting. An entry is
 * deleted only once the file fits, which the guard also enforces.
 *
 * It is empty. The last two entries were the split test suites
 * (tests/integration/api-flow.test.ts and tests/unit/cli-commands.test.ts),
 * now four use-case files each. Nothing is over the 650 ceiling, so there
 * should be no reason to add an entry: split the module instead.
 *
 * What the script cannot see is the previous value of the map: growing a file
 * and adding or raising an entry in the same commit reads as a clean baseline.
 * That one is caught by reviewing this diff, not by the check.
 */
const BASELINE = new Map();

function countLines(path) {
  // Count real lines: a file ending in "\n" must not gain a phantom line.
  return readFileSync(path, "utf8").replace(/\n$/, "").split("\n").length;
}

function printBaseline() {
  console.error(`baseline (over ${MAX_LINES} lines, pinned to the exact count):`);
  for (const [path, lines] of [...BASELINE].sort((a, b) => b[1] - a[1])) {
    console.error(`  ${lines}\t${path}`);
  }
}

/** Every counted source file under `dir`. */
function* sources(dir) {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* sources(path);
    } else if (SOURCE_EXTENSIONS.has(extname(entry).toLowerCase())) {
      yield path;
    }
  }
}

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "bin") continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      yield* files(path);
    } else if (path.endsWith(".ts") || path.endsWith(".go")) {
      yield path;
    }
  }
}

const offenders = [];
const unused = [];
const grew = [];
const shrank = [];
const seen = new Set();

for (const path of sources(ROOT)) {
  const rel = relative(ROOT, path);
  const lines = countLines(path);
  const baseline = BASELINE.get(rel);
  seen.add(rel);
  if (baseline === undefined) {
    if (lines > MAX_LINES) offenders.push({ path: rel, lines });
  } else if (lines <= MAX_LINES) {
    // Fixed: the entry has to go in the same change.
    unused.push({ path: rel, lines, baseline });
  } else if (lines > baseline) {
    grew.push({ path: rel, lines, baseline });
  } else if (lines < baseline) {
    shrank.push({ path: rel, lines, baseline });
  }
}
for (const [rel, baseline] of BASELINE) {
  if (!seen.has(rel)) unused.push({ path: rel, lines: 0, baseline });
}

if (offenders.length + unused.length + grew.length + shrank.length > 0) {
  if (offenders.length > 0) {
    console.error(`files over ${MAX_LINES} lines that are not in BASELINE (split them):`);
    for (const { path, lines } of offenders.sort((a, b) => b.lines - a.lines)) {
      console.error(`  ${lines}\t${path}`);
    }
  }
  if (grew.length > 0) {
    console.error(
      "BASELINE files that grew (the pinned count may only go down; split the file):",
    );
    for (const { path, lines, baseline } of grew.sort((a, b) => b.lines - a.lines)) {
      console.error(`  ${path}: ${lines} lines now, baselined at ${baseline}`);
    }
  }
  if (shrank.length > 0) {
    console.error(
      "BASELINE files that shrank (lower the pinned count; delete the entry once it fits):",
    );
    for (const { path, lines, baseline } of shrank.sort((a, b) => b.lines - a.lines)) {
      console.error(`  ${path}: ${lines} lines now, baselined at ${baseline}`);
    }
  }
  if (unused.length > 0) {
    console.error(
      "BASELINE entries at or under budget (delete them, the ratchet only shrinks):",
    );
    for (const { path, lines, baseline } of unused.sort((a, b) => b.baseline - a.baseline)) {
      const now = lines === 0 ? "gone or no longer counted" : `${lines} lines now`;
      console.error(`  ${path}: ${now}, baselined at ${baseline}`);
    }
  }
  if (BASELINE.size > 0) printBaseline();
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Function length                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The function budget.
 *
 * The file check above counted files, and it passed on `api/src/server.ts`,
 * which was 267 lines with 200 of them in `createApp`. Splitting a god file
 * into a god function moved the problem inside the module and the guard called
 * it fixed, so the same ratchet runs one level down: no function over
 * `FUNCTION_BUDGET` lines unless it is pinned, and a pinned count may only go
 * down.
 *
 * `FUNCTION_MAX_LINES` is the ceiling a *new* function has to stay under. The
 * check cannot fail on it separately, because anything over it is already over
 * the budget and has to be pinned, which this file does not accept for new code.
 */
const FUNCTION_BUDGET = 50;
const FUNCTION_MAX_LINES = 80;

/**
 * The over-budget functions, pinned to the exact line count each one is at.
 *
 * Same rules as `BASELINE`: an unpinned function over the budget fails, a
 * pinned one may not grow, a pinned one may not shrink without the pin being
 * lowered in the same change, and the entry is deleted once the function fits.
 * Keys are `path::name` so a failure names the function as well as the file.
 *
 * The reason is part of the entry, not decoration. A function is allowed to sit
 * above the budget only when the reason names the distinct things it does, so
 * the next reader knows where to split it. "It is long" is not a reason and
 * gets the entry deleted instead.
 */
const FUNCTION_BASELINE = new Map([
  ["tests/unit/store-contract/suite.ts::describeStoreContract", [421, "one suite over every store port, one case per method, on one fixture"]],
  ["controller/src/control-api/payments.ts::registerPaymentRoutes", [387, "eight internal payment routes in one registration"]],
  ["controller/src/egress-proxy.ts::createEgressProxy", [372, "the CONNECT path inline: verify, admit, resolve, dial, splice"]],
  ["controller/src/control-api/sessions.ts::registerSessionRoutes", [347, "seven internal session routes in one registration"]],
  ["controller/src/main.ts::start", [281, "three boot phases: config and lease, listeners, reconciler"]],
  ["controller/src/egress-proxy.ts::handleConnect", [275, "one tunnel from token to splice, defined inside the factory"]],
  ["api/src/routes/sessions.ts::createSessionsRouter", [243, "six route groups plus the capability check they share"]],
  ["controller/src/relay/http.ts::registerRelayControlRoutes", [222, "eleven relay control routes in one registration"]],
  ["tests/integration/support/api-harness.ts::startHarness", [207, "boots API, controller, facilitator and store for one test"]],
  ["scripts/control-faults.ts::lifecycleRestart", [206, "fault script: seed, kill, wait for convergence, report"]],
  ["api/src/server.ts::createApp", [200, "middleware, facilitator, routes and probes in one composition root"]],
  ["controller/src/control-api.ts::createControlApi", [178, "mounts every internal route group behind auth and metrics"]],
  ["controller/src/refund-worker.ts::run", [173, "one pass: gauges, claim, send, record, settle"]],
  ["controller/src/provisioning/readiness.ts::awaitReady", [170, "poll loop over warm claim, pod ready, relay and evidence"]],
  ["tests/helpers/create-route.ts::postCreate", [168, "builds a signed payment, posts it, asserts the answer"]],
  ["shared/src/tiers.ts::resolveSessionSpec", [164, "tier lookup, limit merge and six refusal paths"]],
  ["controller/src/warm-pool.ts::tryClaim", [161, "pick, reserve, address and register one warm pod"]],
  ["controller/src/effects.ts::executeEffect", [157, "the effect switch, one case per session effect"]],
  ["tests/property/warm-pool-claims.test.ts::harness", [156, "fixture: config, clock, pool and claim doubles"]],
  ["tests/helpers/warm-pool-harness.ts::harness", [155, "fixture: config, clock, pods and the delete log"]],
  ["tests/unit/create-path.test.ts::harness", [136, "fixture: store, provisioner, relay and settle doubles"]],
  ["shared/src/domain/session.ts::transition", [135, "the lifecycle switch, one case per state and event family"]],
  ["controller/src/k8s-pod.ts::buildPod", [132, "the pod spec: containers, probes, volumes, security"]],
  ["controller/src/store/postgres/payments.ts::completeEntitlement", [132, "one transaction: intent, session insert, reservation"]],
  ["api/src/mock-facilitator.ts::createMockFacilitator", [127, "sqlite nonce store plus the four facilitator routes"]],
  ["controller/src/relay/ws.ts::handleGuestConnection", [127, "hello, decode, dispatch, reply and close for one socket"]],
  ["api/src/use-cases/create-session.ts::createSession", [124, "validate, switch, claim, verify, settle, complete"]],
  ["guest/transfers.go::init", [124, "transfer validation: id, direction, size and path"]],
  ["sdk/src/payment.ts::createPayer", [124, "builds the payer: client, address, signer and its methods"]],
  ["cli/src/index.ts::main", [123, "arg parsing, early commands and dispatch"]],
  ["scripts/fault-scenarios/relay-kill.ts::relayKill", [123, "seed, kill the relay, wait for convergence, report"]],
  ["tests/unit/helpers/warm-pool-fixtures.ts::harness", [123, "fixture: config, clock, pods and deletes"]],
  ["api/src/use-cases/create-session-completion.ts::completeEntitlement", [120, "the durable half: claim, create, settle, respond"]],
  ["guest/main.go::runWarm", [119, "warm boot: env, relay, register, serve loop"]],
  ["tests/integration/relay-reconnect.test.ts::scenario", [117, "boot relay and guest, drop the link, assert reconnect"]],
  ["sdk/src/payment.ts::createSession", [115, "the paid create: 402, sign, retry with the header"]],
  ["guest/main.go::runSession", [114, "session boot: limits, supervisor, relay, shutdown"]],
  ["guest/supervisor.go::handleRequest", [113, "frame dispatch: slot, decrypt, route, encrypt, reply"]],
  ["shared/src/attestation.ts::verifyAttestation", [111, "parse, version, freshness, PCR and signature checks"]],
  ["cli/src/allowlist-admin.ts::runAdmin", [108, "admin commands: list, add, remove, revoke"]],
  ["controller/src/reconciler.ts::constructor", [105, "wires the clock guard and every bounded sub-policy"]],
  ["controller/src/relay.ts::createRelay", [104, "registers metrics, the registry and both control route groups"]],
  ["controller/src/lifecycle.ts::resume", [103, "guard, reserve, PVC, pod, transition, register"]],
  ["tests/helpers/lifecycle-harness.ts::harness", [103, "fixture: fake store, provisioner and pod logs"]],
  ["controller/src/ledger-audit-sampler.ts::createLedgerAuditSampler", [102, "the sampler closure: limits, clock and the audit pass"]],
  ["controller/src/relay-recovery.ts::reconcileSession", [102, "one session: lease, registry, reset and metric"]],
  ["guest/transfers_fuzz_test.go::FuzzTransferFraming", [102, "fuzz target: seed corpus plus the framing checks"]],
  ["guest/internal/files/archive.go::extractTarReader", [101, "tar in: entry checks, path resolve, write"]],
  ["tests/integration/relay-restart.test.ts::scenario", [101, "two relays, a guest and a restart window"]],
  ["controller/src/operation-fence.ts::reconcile", [100, "clears and holds fenced sessions in one pass"]],
  ["tests/helpers/reconciler-harness.ts::harness", [96, "fixture: tick store, clock and the effect log"]],
  ["examples/node-http-service/workload.ts::main", [95, "the example end to end: create, run, fetch, destroy"]],
  ["tests/helpers/transfer-guest.ts::respond", [95, "the transfer operation switch for the fake guest"]],
  ["guest/internal/canonical/canonical.go::write", [94, "canonical JSON: one case per Go type"]],
  ["tests/unit/support/leadership-fence-harness.ts::openWedgeWorld", [94, "opens the store, the lease and two would-be leaders"]],
  ["tests/unit/relay-recovery.test.ts::harness", [93, "fixture: sessions, registry and clock"]],
  ["sdk/src/transfers.ts::download", [89, "open, read chunks, verify the hash, write"]],
  ["guest/internal/runner/runner.go::Execute", [88, "run one command: limits, capture, timeout, result"]],
  ["tests/helpers/session-control-api.ts::startSessionControlApi", [88, "fresh store, seed and two listeners"]],
  ["controller/src/warm-pool.ts::reconcile", [87, "target, create, delete and surplus in one pass"]],
  ["tests/integration/stale-frame-reset-outcome.test.ts::scenario", [87, "relay, guest, stale frame and the reset assertions"]],
  ["guest/internal/files/archive_test.go::TestArchiveRejectsUnsafeEntries", [86, "table of hostile tar entries"]],
  ["controller/src/reconciler.ts::tick", [85, "the phase order: lease, cleanup, readiness, dispatch"]],
  ["sdk/src/transfers.ts::upload", [84, "hash, chunk, send, finalise"]],
  ["tests/helpers/guest.ts::start", [84, "boots the relay and the guest for one test"]],
  ["guest/internal/files/archive.go::TarToFile", [80, "tar out: entry header, body, close"]],
  ["shared/src/payment.ts::validate", [80, "the mock scheme's payload checks, one per refusal"]],
  ["guest/transfers.go::complete", [79, "finalise: hash, size, move, reply"]],
  ["scripts/capacity-demo.ts::main", [79, "the capacity demo: create, occupy, exhaust, report"]],
  ["sdk/src/data-plane.ts::openWebSocket", [79, "open operation, upgrade, attach the readers"]],
  ["examples/python-data-processing/workload.ts::main", [78, "the python example end to end"]],
  ["controller/src/main.ts::checkRuntimeClass", [77, "reads the node's runtime classes and refuses a mismatch"]],
  ["guest/cmd/netprobe/main.go::runProbe", [77, "dial, measure and classify one probe"]],
  ["sdk/src/session.ts::create", [77, "keys, spec, post, store the handle"]],
  ["shared/src/runtime-metrics.ts::registerRuntimeMetrics", [77, "registers each process metric family"]],
  ["guest/supervisor_fuzz_test.go::FuzzSupervisorDecrypt", [76, "fuzz target: keys, frames and the decrypt checks"]],
  ["tests/unit/runtime-contract.test.ts::post", [76, "builds the app and posts one create body"]],
  ["sdk/src/runtime.ts::waitForReady", [75, "poll loop with backoff and transport retry"]],
  ["controller/src/store/postgres/reservations.ts::admitWithin", [74, "admission inside a transaction: hold, upsert, verdict"]],
  ["tests/helpers/fake-apiserver.ts::reply", [73, "the fake API server's route switch"]],
  ["scripts/control-faults.ts::relayPause", [72, "fault script: seed, pause the relay, report"]],
  ["scripts/lifecycle-portability.ts::main", [72, "the portability demo: pin, cordon, resume"]],
  ["sdk/src/run.ts::runOnce", [72, "validate, exec, poll, return the result"]],
  ["controller/src/control-api/create-switch.ts::registerCreateSwitchRoutes", [71, "read and write of the create kill switch"]],
  ["sdk/src/data-plane.ts::openHttpStream", [71, "open operation, chunked body, reader closures"]],
  ["tests/unit/effects.test.ts::harness", [70, "fixture: recording runtime and one session"]],
  ["api/src/use-cases/create-session-settlement.ts::resolveRefusedSettle", [68, "settle refusals: verify, decide, respond"]],
  ["cli/src/commands.ts::runOneShot", [68, "the one-shot command path and its messages"]],
  ["tests/unit/payer-allowlist-store.test.ts::seedSession", [68, "inserts one session with its reservation"]],
  ["api/src/config.ts::loadConfig", [67, "composes the config from its parsers, one section each"]],
  ["controller/src/store/postgres/operations.ts::claimOperation", [67, "the claim statement, its conflict cases and the result"]],
  ["controller/src/warm-pool-manager.ts::reconcile", [67, "normalise, list, create and delete warm pods"]],
  ["controller/src/warm-pool.ts::create", [67, "create one warm pod: spec, admit, track"]],
  ["controller/src/provisioning/pod-creation.ts::createPod", [66, "pod create: spec, admit, register, record"]],
  ["controller/src/provisioning.ts::provisionWithSlot", [66, "admission in front of the create transition"]],
  ["api/src/payments/facilitator-client.ts::send", [65, "one facilitator call with timeout, retry and parse"]],
  ["controller/src/settlement-recovery.ts::chainAnswer", [64, "asks the chain verifier and maps the verdict"]],
  ["controller/src/store/postgres/payments.ts::claimPaymentIntent", [64, "the intent claim statement and its outcomes"]],
  ["guest/internal/runner/service.go::StartService", [64, "spawn, probe, register and log one service"]],
  ["guest/transfers_fuzz_test.go::FuzzChunkDecode", [64, "fuzz target: chunk framing and the hash checks"]],
  ["scripts/fault-scenarios/relay-create-restart.ts::relayCreateRestart", [64, "seed, restart the relay mid-create, report"]],
  ["guest/internal/files/archive.go::tarPath", [63, "lstat, read, header and entry for one path"]],
  ["controller/src/local-provisioner.ts::createPod", [61, "in-memory pod: create, start, track"]],
  ["tests/integration/restore-drill.test.ts::seedSource", [61, "seeds the source database for the restore drill"]],
  ["guest/internal/files/files.go::List", [60, "walk, stat and map the entries"]],
  ["controller/src/relay/ws.ts::attachGuestUpgrade", [59, "upgrade, token check, dispatch"]],
  ["controller/src/relay-client.ts::registerCurrent", [59, "registration with the generation precondition and retry"]],
  ["controller/src/session-view.ts::describeSession", [59, "the view: row, relay, pod and timings"]],
  ["controller/src/store/budget-decision.ts::decideBudget", [59, "the verdict: caps, spend and window"]],
  ["guest/services.go::startService", [59, "validate, spawn, probe, reply"]],
  ["tests/helpers/session-control-api.ts::response", [59, "the fake controller's answer script"]],
  ["tests/unit/effects.test.ts::recordingRuntime", [59, "records each runtime call"]],
  ["tests/unit/relay-registration.test.ts::startFakeRelay", [59, "the fake relay's two routes"]],
  ["api/src/config.ts::parsePayment", [58, "the payment-mode rules, one per refusal"]],
  ["controller/src/reconciler/lease-health.ts::enforce", [58, "probe, classify and escalate one session"]],
  ["tests/security/attacker-helpers.ts::slowloris", [58, "opens sockets slowly and measures the refusal"]],
  ["api/src/connection-limit.ts::createConnectionLimiter", [57, "the limiter closure and its refusals"]],
  ["controller/src/settlement-recovery.ts::run", [57, "list stale intents, ask the chain, record"]],
  ["controller/src/local-provisioner.ts::createWarmPod", [56, "in-memory warm pod: dirs, spec, track"]],
  ["controller/src/store/postgres/sessions.ts::insert", [55, "the column list and its parameters"]],
  ["controller/src/k8s.ts::createWarmPod", [54, "build and apply the warm pod spec"]],
  ["controller/src/leadership.ts::acquireWithRetry", [54, "retries the lease until the deadline"]],
  ["controller/src/leadership.ts::bindLeadership", [58, "binds the acquire retries and the lease callbacks"]],
  ["controller/src/provisioning.ts::startProvisionPod", [54, "start the pod and register the relay"]],
  ["controller/src/store/models/session.ts::mapSession", [54, "row to record, one field per column"]],
  ["scripts/lifecycle-faults.ts::main", [54, "the lifecycle fault demo"]],
  ["tests/fuzz/create-session.fuzz.test.ts::startApp", [54, "builds the app under test from fuzz options"]],
  ["controller/src/store/postgres/reservations.ts::resume", [53, "re-acquires the hold inside one transaction"]],
  ["guest/streams.go::openStream", [53, "target, dial, stream, close"]],
  ["tests/helpers/session-control-api.ts::seed", [53, "inserts one session per seeded state"]],
  ["tests/unit/payer-budget.test.ts::seedLiveSession", [53, "inserts a live session and its reservation"]],
  ["api/src/config.ts::parseCredentials", [52, "the admin token and the capability key ring"]],
  ["controller/src/k8s.ts::createPod", [52, "build and apply the session pod spec"]],
  ["examples/node-http-service/faults.ts::main", [52, "the example's fault walkthrough"]],
  ["guest/internal/attest/attest.go::BuildEvidence", [52, "assembles the dev evidence document"]],
  ["guest/supervisor.go::serve", [52, "the link loop with reconnect"]],
  ["guest/websockets.go::openWS", [52, "target, upgrade, poll loop"]],
  ["tests/integration/relay-reconnect.test.ts::sessionRecord", [52, "one session row for the fixture"]],
  ["tests/unit/sdk-runtime.test.ts::readyStatus", [52, "a signed ready status for the fixture"]],
  ["controller/src/reconciler/dispatch.ts::run", [51, "bounded concurrency over one phase"]],
  ["scripts/control-faults.ts::provisioningKill", [51, "fault script: seed, kill provisioning, report"]],
  ["tests/helpers/tls.ts::makeTestPki", [51, "generates the CA, relay and client certificates"]],
  ["tests/integration/relay-restart.test.ts::sessionRecord", [51, "one session row for the fixture"]],
  ["tests/integration/stale-frame-reset-outcome.test.ts::sessionRecord", [51, "one session row for the fixture"]],
]);

function printFunctionBaseline() {
  console.error(`function baseline (over ${FUNCTION_BUDGET} lines, pinned to the exact count):`);
  for (const [key, [lines, reason]] of [...FUNCTION_BASELINE].sort((a, b) => b[1][0] - a[1][0])) {
    console.error(`  ${lines}\t${key}  ${reason}`);
  }
}

const fnOffenders = [];
const fnUnused = [];
const fnGrew = [];
const fnShrank = [];
const fnSeen = new Set();

for (const path of sources(ROOT)) {
  const rel = relative(ROOT, path);
  const lang = path.endsWith(".go") ? "go" : "ts";
  for (const { name, lines, startLine } of functionSpans(readFileSync(path, "utf8"), lang)) {
    const key = `${rel}::${name}`;
    const pinned = FUNCTION_BASELINE.get(key);
    fnSeen.add(key);
    if (pinned === undefined) {
      if (lines > FUNCTION_BUDGET) fnOffenders.push({ key, lines, startLine });
    } else if (lines <= FUNCTION_BUDGET) {
      // Fixed: the entry goes in the same change, exactly like the file map.
      fnUnused.push({ key, lines, pinned: pinned[0] });
    } else if (lines > pinned[0]) {
      fnGrew.push({ key, lines, pinned: pinned[0] });
    } else if (lines < pinned[0]) {
      fnShrank.push({ key, lines, pinned: pinned[0] });
    }
  }
}
for (const [key, [lines]] of FUNCTION_BASELINE) {
  if (!fnSeen.has(key)) fnUnused.push({ key, lines: 0, pinned: lines });
}

if (fnOffenders.length + fnUnused.length + fnGrew.length + fnShrank.length > 0) {
  if (fnOffenders.length > 0) {
    console.error(
      `functions over ${FUNCTION_BUDGET} lines that are not in FUNCTION_BASELINE (split them):`,
    );
    for (const { key, lines, startLine } of fnOffenders.sort((a, b) => b.lines - a.lines)) {
      console.error(`  ${lines}\t${key} (starts line ${startLine})`);
    }
    if (fnOffenders.some((fn) => fn.lines > FUNCTION_MAX_LINES)) {
      console.error(
        `  a new function over the ${FUNCTION_MAX_LINES}-line ceiling is not eligible for an entry at all: split it by use case first`,
      );
    }
  }
  if (fnGrew.length > 0) {
    console.error(
      "FUNCTION_BASELINE functions that grew (the pinned count may only go down; split the function):",
    );
    for (const { key, lines, pinned } of fnGrew.sort((a, b) => b.lines - a.lines)) {
      console.error(`  ${key}: ${lines} lines now, baselined at ${pinned}`);
    }
  }
  if (fnShrank.length > 0) {
    console.error(
      "FUNCTION_BASELINE functions that shrank (lower the pinned count; delete the entry once it fits):",
    );
    for (const { key, lines, pinned } of fnShrank.sort((a, b) => b.lines - a.lines)) {
      console.error(`  ${key}: ${lines} lines now, baselined at ${pinned}`);
    }
  }
  if (fnUnused.length > 0) {
    console.error(
      "FUNCTION_BASELINE entries at or under budget (delete them, the ratchet only shrinks):",
    );
    for (const { key, lines, pinned } of fnUnused.sort((a, b) => b.pinned - a.pinned)) {
      const now = lines === 0 ? "gone or no longer counted" : `${lines} lines now`;
      console.error(`  ${key}: ${now}, baselined at ${pinned}`);
    }
  }
  if (FUNCTION_BASELINE.size > 0) printFunctionBaseline();
  process.exit(1);
}

/**
 * Shared layering guard.
 *
 * `@x402s/shared` used to be a single barrel, so importing a wire type also
 * evaluated `crypto.ts` (node:crypto + libsodium-wrappers) and the metrics
 * listeners (node:http, node:perf_hooks). The subpath entry points in
 * `shared/src/entries/` fix that only as long as the graph stays layered:
 * anything a pure module imports is what a pure consumer pays for.
 *
 * Order matters. A module may import the layers below it and no further:
 *
 *   0 pure     types, decisions, env parsing. No I/O, no node builtins.
 *   1 crypto   node:crypto, libsodium-wrappers.
 *   2 payment  x402 schemes and the tier table on top of crypto.
 *   3 runtime  listeners, metrics, logs, rate limits, settlement lookup.
 *
 * Two edges are forbidden even though the order would allow them: runtime must
 * not reach crypto or payment. A process that only serves metrics or writes
 * logs should not load libsodium, which is the same reason the subpaths exist.
 *
 * `index.ts` and `entries/*` are aggregators and may import any layer.
 */
const SHARED = "shared/src";
const SHARED_LAYERS = [
  {
    name: "pure",
    pure: true,
    match: (rel) =>
      [
        "fp.ts",
        "protocol.ts",
        "env.ts",
        "ip.ts",
        "dev-attestation.ts",
        "runtimes.ts",
        "money.ts",
        // Backoff is arithmetic plus an injected random source. It is exported
        // from the `runtime` entry because that is who consumes it, but it has
        // no clock, no I/O and no process state, so it belongs in this layer and
        // `durable/` may import it.
        "backoff.ts",
      ].includes(rel) ||
      rel.startsWith("protocol/") ||
      rel.startsWith("domain/") ||
      // The durable-call protocol (ADR 0011): pure predicates and value
      // objects shared by the API and the controller. No SQL, no I/O.
      rel.startsWith("durable/"),
  },
  {
    name: "crypto",
    match: (rel) =>
      ["crypto.ts", "commitment.ts", "attestation.ts", "capability.ts"].includes(rel),
  },
  {
    name: "payment",
    match: (rel) => ["payment.ts", "tiers.ts", "settlement-verifier.ts", "settlement-verdict.ts"].includes(rel),
  },
  {
    name: "runtime",
    match: (rel) =>
      [
        "log.ts",
        "metrics.ts",
        "metrics-http.ts",
        "http-metrics.ts",
        "runtime-metrics.ts",
        "admission-metrics.ts",
        "request-metrics.ts",
        "rate-limit.ts",
        "readiness.ts",
        "settlement.ts",
      ].includes(rel),
  },
];

const isAggregator = (rel) => rel === "index.ts" || rel.startsWith("entries/");

/** Layer edges that the linear order allows but that must not exist. */
const FORBIDDEN_EDGES = new Set(["runtime->crypto", "runtime->payment"]);

function sharedModules() {
  return [...files(join(ROOT, SHARED))]
    .filter((path) => path.endsWith(".ts"))
    .map((path) => relative(join(ROOT, SHARED), path).replaceAll("\\", "/"))
    .sort();
}

function layerOf(rel) {
  const index = SHARED_LAYERS.findIndex((layer) => layer.match(rel));
  return index === -1 ? null : index;
}

/** Every module specifier in the file: static imports, re-exports, dynamic. */
function importsOf(path) {
  const text = readFileSync(path, "utf8");
  const found = new Set();
  for (const re of [
    /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^;]*?from\s*["']([^"']+)["']/gs,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of text.matchAll(re)) found.add(match[1]);
  }
  return [...found];
}

/** Resolve a relative specifier to a module path relative to `shared/src`. */
function resolveSpecifier(fromRel, specifier) {
  const target = posix.normalize(posix.join(posix.dirname(fromRel), specifier));
  return target.replace(/\.js$/, ".ts");
}

const modules = sharedModules();
const unclassified = modules.filter((rel) => !isAggregator(rel) && layerOf(rel) === null);
const layeringOffenders = [];

for (const rel of modules) {
  if (isAggregator(rel)) continue;
  const index = layerOf(rel);
  if (index === null) continue; // reported as unclassified below
  const layer = SHARED_LAYERS[index];
  const pure = layer.pure === true;
  for (const specifier of importsOf(join(ROOT, SHARED, rel))) {
    if (!specifier.startsWith(".")) {
      // A pure module must not reach node builtins or a package: that is the
      // whole point of the pure layer, and it is what keeps ./protocol free.
      if (pure) layeringOffenders.push(`${rel} imports "${specifier}"`);
      continue;
    }
    const target = resolveSpecifier(rel, specifier);
    const targetIndex = layerOf(target);
    if (targetIndex === null) continue;
    const targetLayer = SHARED_LAYERS[targetIndex];
    if (targetIndex > index || FORBIDDEN_EDGES.has(`${layer.name}->${targetLayer.name}`)) {
      layeringOffenders.push(
        `${rel} (${layer.name}) imports ${target} (${targetLayer.name})`,
      );
    }
  }
}

/** Every module reachable by following re-exports from `rel`. */
function exportedClosure(rel, seen = new Set()) {
  if (seen.has(rel)) return seen;
  seen.add(rel);
  for (const specifier of importsOf(join(ROOT, SHARED, rel))) {
    if (!specifier.startsWith(".")) continue;
    const target = resolveSpecifier(rel, specifier);
    if (modules.includes(target)) exportedClosure(target, seen);
  }
  return seen;
}

// There is no root barrel. `@x402s/shared` resolves only through the subpaths
// under `entries/`, so every module has to be reachable from at least one of
// them: a module no entry re-exports is surface nobody can import, and one that
// grows back is the coupling the split removed.
const reachable = new Set();
for (const entry of modules.filter((rel) => rel.startsWith("entries/"))) {
  for (const rel of exportedClosure(entry)) reachable.add(rel);
}
const unexported = modules.filter((rel) => !isAggregator(rel) && !reachable.has(rel));
const barrelBack = existsSync(join(ROOT, SHARED, "index.ts"));

// Each subpath must be the single home of its symbols. Two entries exporting
// the same name means a consumer can import it from either, so the layering
// stops telling you where a symbol's dependencies come from.
function reexportsOf(path) {
  const text = readFileSync(path, "utf8");
  const wildcards = [];
  for (const match of text.matchAll(/(?:^|\n)\s*export\s+(?:type\s+)?\*\s+from\s*["']([^"']+)["']/g)) {
    wildcards.push(match[1]);
  }
  return wildcards;
}

/** Names a module contributes: its own declarations plus its re-exports. */
function exportedNames(rel, seen = new Set()) {
  if (seen.has(rel)) return new Set();
  seen.add(rel);
  const text = readFileSync(join(ROOT, SHARED, rel), "utf8");
  const names = new Set();
  for (const match of text.matchAll(
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm,
  )) {
    names.add(match[1]);
  }
  // `export { a, b as c }` and `export { a } from "./x.js"`: named, not wildcard.
  for (const match of text.matchAll(
    /(?:^|\n)\s*export\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*["'][^"']+["'])?/g,
  )) {
    for (const part of match[1].split(",")) {
      const alias = part.split(/\s+as\s+/);
      const name = (alias[1] ?? alias[0]).trim();
      if (name) names.add(name);
    }
  }
  for (const specifier of reexportsOf(join(ROOT, SHARED, rel))) {
    const target = resolveSpecifier(rel, specifier);
    if (target === rel || !modules.includes(target)) continue;
    for (const name of exportedNames(target, seen)) names.add(name);
  }
  return names;
}

const sharedEntries = modules.filter((rel) => rel.startsWith("entries/"));
const entryOwners = new Map();
const duplicateExports = [];
for (const entry of sharedEntries) {
  for (const name of exportedNames(entry)) {
    const owner = entryOwners.get(name);
    if (owner !== undefined) duplicateExports.push(`${name}: ${owner} and ${entry}`);
    else entryOwners.set(name, entry);
  }
}

if (unclassified.length > 0) {
  console.error("shared/src modules with no layer (add them to SHARED_LAYERS):");
  for (const rel of unclassified) console.error(`  ${rel}`);
}
if (unexported.length > 0) {
  console.error("shared/src modules reachable from no entry:");
  for (const rel of unexported) console.error(`  ${rel}`);
}
if (barrelBack) {
  console.error(
    "shared/src/index.ts exists again: there is no root barrel, add the module to an entry instead",
  );
}
if (layeringOffenders.length > 0) {
  console.error("shared/src layering violations (see the guard above):");
  for (const line of layeringOffenders) console.error(`  ${line}`);
}
if (duplicateExports.length > 0) {
  console.error("shared/src symbols reachable from more than one subpath:");
  for (const line of duplicateExports) console.error(`  ${line}`);
}
if (
  unclassified.length +
    unexported.length +
    layeringOffenders.length +
    duplicateExports.length +
    (barrelBack ? 1 : 0) >
  0
) {
  process.exit(1);
}

console.log(
  `structure ok: every module is <= ${MAX_LINES} lines (${BASELINE.size} baselined); ` +
    `no function over the ${FUNCTION_BUDGET}-line budget is unpinned ` +
    `(${FUNCTION_BASELINE.size} baselined, ceiling ${FUNCTION_MAX_LINES}); ` +
    `${modules.length} shared modules layered, ` +
    `${entryOwners.size} symbols over ${sharedEntries.length} entries, no root barrel`,
);
