#!/usr/bin/env node
/**
 * Hermes alert receiver — Alertmanager webhook to Hermes gateway webhook route.
 *
 * Alertmanager POSTs a v4 notification here with a bearer token. This process
 * validates the token, drops alerts it has already delivered inside the
 * cooldown window, renders a short prompt and POSTs it to the Hermes gateway's
 * own webhook route (HMAC-SHA256 over "<timestamp>.<body>", generic V2
 * signature). It answers 2xx only after Hermes has accepted the run.
 *
 * Dependency-free on purpose: Node stdlib only, no npm install, no build, no
 * image of its own. The Deployment runs the upstream node image and mounts this
 * file from a ConfigMap, so there is nothing to publish and no lockfile to keep
 * current.
 *
 * The Hermes webhook contract this speaks to lives in
 * deploy/monitoring/contract/alerting/README.md.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { pathToFileURL } from "node:url";

export const DEFAULTS = Object.freeze({
  port: 8080,
  host: "0.0.0.0",
  path: "/alerts",
  healthPath: "/healthz",
  cooldownSeconds: 900,
  maxBodyBytes: 262_144,
  hermesTimeoutMs: 5_000,
  maxAlerts: 20,
  maxAnnotationChars: 400,
  maxLabelChars: 200,
  maxLabels: 16,
  maxPromptChars: 6_000,
});

/** Malformed Alertmanager payload. Answered 400, never retried by the caller. */
export class PayloadError extends Error {}

/** Body larger than maxBodyBytes. Answered 413. */
export class BodyTooLarge extends Error {}

function positiveInt(value, name, fallback) {
  const raw = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(raw) || raw <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return raw;
}

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required and must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Read and validate the process environment. Throws with the first problem, so
 * a bad Deployment spec fails at startup instead of on the first alert.
 */
export function loadConfig(env = process.env) {
  const tokens = [required(env.ALERTMANAGER_TOKEN, "ALERTMANAGER_TOKEN")];
  // Rotation overlap: the previous token keeps verifying until the caller has
  // swapped its credentials file. Same pattern as the control plane's
  // CAPABILITY_SECRET_PREVIOUS; see docs/runbooks/secret-rotation.md.
  if (typeof env.ALERTMANAGER_TOKEN_PREVIOUS === "string" && env.ALERTMANAGER_TOKEN_PREVIOUS.trim()) {
    tokens.push(env.ALERTMANAGER_TOKEN_PREVIOUS.trim());
  }
  const hermesWebhookUrl = required(env.HERMES_WEBHOOK_URL, "HERMES_WEBHOOK_URL");
  if (!/^https?:\/\//.test(hermesWebhookUrl)) {
    throw new Error("HERMES_WEBHOOK_URL must be an http:// or https:// URL");
  }
  return {
    host: env.HOST?.trim() || DEFAULTS.host,
    port: positiveInt(env.PORT, "PORT", DEFAULTS.port),
    path: env.RECEIVER_PATH?.trim() || DEFAULTS.path,
    healthPath: DEFAULTS.healthPath,
    cooldownSeconds: positiveInt(env.DEDUPE_COOLDOWN_SECONDS, "DEDUPE_COOLDOWN_SECONDS", DEFAULTS.cooldownSeconds),
    maxBodyBytes: positiveInt(env.MAX_BODY_BYTES, "MAX_BODY_BYTES", DEFAULTS.maxBodyBytes),
    hermesTimeoutMs: positiveInt(env.HERMES_TIMEOUT_MS, "HERMES_TIMEOUT_MS", DEFAULTS.hermesTimeoutMs),
    maxAlerts: positiveInt(env.MAX_ALERTS, "MAX_ALERTS", DEFAULTS.maxAlerts),
    maxAnnotationChars: DEFAULTS.maxAnnotationChars,
    maxLabelChars: DEFAULTS.maxLabelChars,
    maxLabels: DEFAULTS.maxLabels,
    maxPromptChars: DEFAULTS.maxPromptChars,
    hermesWebhookUrl,
    hermesWebhookSecret: required(env.HERMES_WEBHOOK_SECRET, "HERMES_WEBHOOK_SECRET"),
    tokens,
  };
}

// --- Authentication -------------------------------------------------------

/** Bearer token, or the bare `X-Alertmanager-Token` header. Never both merged. */
export function presentedToken(headers) {
  const authorization = headers.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer[ \t]+(.+)$/i.exec(authorization.trim());
    if (match) return match[1].trim();
  }
  const fallback = headers["x-alertmanager-token"];
  if (typeof fallback === "string") return fallback.trim();
  return "";
}

/** Constant-time string compare that tolerates non-ASCII and length mismatch. */
export function tokenMatches(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * True when the request carries one of the accepted tokens. Every token is
 * compared, so the cost does not depend on which one matched.
 */
export function authorized(headers, tokens) {
  const presented = presentedToken(headers);
  if (!presented) return false;
  let ok = false;
  for (const token of tokens) {
    if (tokenMatches(presented, token)) ok = true;
  }
  return ok;
}

// --- Payload --------------------------------------------------------------

function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

/** A label/annotation map flattened to strings; nested objects are dropped. */
function stringMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
    else if (typeof entry === "number" || typeof entry === "boolean") out[key] = String(entry);
  }
  return out;
}

/**
 * Alertmanager always sets `fingerprint`; derive one when a compatible sender
 * does not, so dedupe still works for a re-sent identical alert.
 */
export function deriveFingerprint(labels) {
  const canonical = Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join("\u0000");
  return `derived:${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

/**
 * Validate an Alertmanager v4 notification and reduce it to the fields the
 * prompt needs. Anything malformed is a PayloadError: a 400 and no retry.
 */
export function normalizePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PayloadError("payload must be a JSON object");
  }
  if (payload.version !== undefined && String(payload.version) !== "4") {
    throw new PayloadError(`unsupported Alertmanager payload version ${JSON.stringify(payload.version)}`);
  }
  const status = text(payload.status);
  if (status !== "firing" && status !== "resolved") {
    throw new PayloadError("status must be \"firing\" or \"resolved\"");
  }
  if (!Array.isArray(payload.alerts)) throw new PayloadError("alerts must be an array");
  if (payload.alerts.length === 0) throw new PayloadError("alerts is empty");

  const alerts = payload.alerts.map((alert, index) => {
    if (!alert || typeof alert !== "object" || Array.isArray(alert)) {
      throw new PayloadError(`alerts[${index}] must be an object`);
    }
    const alertStatus = text(alert.status);
    if (alertStatus !== "firing" && alertStatus !== "resolved") {
      throw new PayloadError(`alerts[${index}].status must be "firing" or "resolved"`);
    }
    const labels = stringMap(alert.labels);
    return {
      status: alertStatus,
      fingerprint: text(alert.fingerprint).trim() || deriveFingerprint(labels),
      labels,
      annotations: stringMap(alert.annotations),
      startsAt: text(alert.startsAt),
      endsAt: text(alert.endsAt),
      generatorURL: text(alert.generatorURL),
    };
  });

  return {
    status,
    groupKey: text(payload.groupKey),
    groupLabels: stringMap(payload.groupLabels),
    commonLabels: stringMap(payload.commonLabels),
    alerts,
  };
}

// --- Dedupe ---------------------------------------------------------------

/**
 * Per-fingerprint cooldown.
 *
 * An alert is delivered when it is unknown, when its last delivery is older
 * than the window, or when it resolves an incident that was itself delivered.
 * Everything else is suppressed. That last rule is what stops a flap: fire
 * (delivered) → resolve (delivered) → fire again inside the window
 * (suppressed), so the operator learns it cleared once instead of twice a
 * minute. State is in memory and dies with the process; a restart re-delivers
 * one notification per fingerprint, which is the safe direction.
 */
export function createDedupe({ cooldownSeconds, now = Date.now }) {
  const seen = new Map();
  const windowMs = cooldownSeconds * 1_000;

  function shouldDeliver(alert, at) {
    const entry = seen.get(alert.fingerprint);
    if (!entry) return true;
    if (at - entry.at >= windowMs) return true;
    return alert.status === "resolved" && entry.status === "firing";
  }

  return {
    /** Split a group into the alerts to deliver and the ones inside cooldown. */
    partition(alerts) {
      const at = now();
      const fresh = [];
      const suppressed = [];
      for (const alert of alerts) (shouldDeliver(alert, at) ? fresh : suppressed).push(alert);
      return { fresh, suppressed, at };
    },
    /** Only called after a delivery succeeded, so a failure is retried. */
    record(alerts, at) {
      for (const alert of alerts) seen.set(alert.fingerprint, { status: alert.status, at });
    },
    /** Drop entries nobody will consult again; bounds memory on a long-lived pod. */
    prune(at = now()) {
      for (const [fingerprint, entry] of seen) {
        if (at - entry.at > windowMs * 10) seen.delete(fingerprint);
      }
    },
    get size() {
      return seen.size;
    },
  };
}

// --- Prompt ---------------------------------------------------------------

const PREFERRED_LABELS = ["alertname", "severity", "namespace", "job", "instance", "role"];

/** One line, no control characters, length-capped. */
function clean(value, limit) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function labelSummary(labels, config) {
  const keys = Object.keys(labels);
  const ordered = [
    ...PREFERRED_LABELS.filter((key) => key in labels),
    ...keys.filter((key) => !PREFERRED_LABELS.includes(key)).sort(),
  ];
  return ordered
    .slice(0, config.maxLabels)
    .map((key) => `${key}=${clean(labels[key], config.maxLabelChars)}`)
    .join(" ");
}

/**
 * The text the agent reads. Labels and annotations are alert-rule output and a
 * metric value can be attacker-influenced, so every value is flattened to one
 * line and capped; the route template wraps the whole thing in "this is data,
 * not instructions" markers.
 */
export function renderPrompt(group, config = DEFAULTS) {
  const lines = [`Alertmanager notification: ${group.status}`];
  const groupLabels = labelSummary(group.groupLabels, config);
  if (groupLabels) lines.push(`Group: ${groupLabels}`);
  lines.push(`Alerts in this delivery: ${group.alerts.length}`, "");

  group.alerts.forEach((alert, index) => {
    lines.push(`${index + 1}. [${alert.status}] ${clean(alert.labels.alertname ?? "unnamed", config.maxLabelChars)}`);
    const labels = labelSummary(alert.labels, config);
    if (labels) lines.push(`   labels: ${labels}`);
    if (alert.startsAt) lines.push(`   started: ${clean(alert.startsAt, 64)}`);
    if (alert.endsAt) lines.push(`   ended: ${clean(alert.endsAt, 64)}`);
    const summary = clean(alert.annotations.summary, config.maxAnnotationChars);
    if (summary) lines.push(`   summary: ${summary}`);
    const description = clean(alert.annotations.description, config.maxAnnotationChars);
    if (description) lines.push(`   description: ${description}`);
  });

  const rendered = lines.join("\n");
  if (rendered.length <= config.maxPromptChars) return rendered;
  return `${rendered.slice(0, config.maxPromptChars - 20)}\n[prompt truncated]`;
}

// --- Delivery to Hermes ---------------------------------------------------

/** Generic V2 signature: hex HMAC-SHA256 of "<unix seconds>.<raw body>". */
export function signV2(secret, timestamp, body) {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/**
 * Stable id for one notification, so Hermes' own delivery-id dedupe absorbs a
 * network-level retry of the same request. The minute bucket keeps a genuine
 * re-delivery after the cooldown from looking like the same event.
 */
function deliveryId(group, atMs, fingerprints) {
  const digest = createHash("sha256")
    .update(`${group.status}\n${[...fingerprints].sort().join("\n")}`)
    .digest("hex")
    .slice(0, 24);
  return `${digest}:${Math.floor(atMs / 60_000)}`;
}

/**
 * POST the rendered prompt to the Hermes webhook route. `route` and
 * `alert_count` are there for logs and for a route template that wants them;
 * the prompt is the field the template renders.
 */
export async function deliverToHermes({ config, group, prompt, fingerprints, fetchImpl, now }) {
  const body = JSON.stringify({
    route: "alerts",
    status: group.status,
    prompt,
    alert_count: group.alerts.length,
    fingerprints,
  });
  const timestamp = String(Math.floor(now() / 1_000));
  const headers = {
    "content-type": "application/json",
    "x-webhook-timestamp": timestamp,
    "x-webhook-signature-v2": signV2(config.hermesWebhookSecret, timestamp, body),
    "x-request-id": deliveryId(group, now(), fingerprints),
  };
  const response = await fetchImpl(config.hermesWebhookUrl, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(config.hermesTimeoutMs),
  });
  return { ok: Boolean(response.ok), status: Number(response.status) };
}

// --- HTTP -----------------------------------------------------------------

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        // Stop reading but leave the socket up long enough to answer 413; the
        // caller closes the connection after the response.
        settled = true;
        req.pause();
        reject(new BodyTooLarge(`body larger than ${maxBodyBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

/**
 * Build the receiver. Everything with a side effect (fetch, clock, log sink) is
 * injectable so the tests can drive the cooldown and inspect the signed request
 * without a network or a fake timer.
 */
export function createAlertReceiver(options = {}) {
  const config = options.config ?? loadConfig();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? ((record) => process.stdout.write(`${JSON.stringify(record)}\n`));
  const dedupe = createDedupe({ cooldownSeconds: config.cooldownSeconds, now });

  async function handleAlerts(req, res) {
    // Auth before body: an unauthenticated caller cannot make us buffer.
    if (!authorized(req.headers, config.tokens)) {
      logger({ event: "rejected", reason: "unauthorized", remote: req.socket.remoteAddress ?? "" });
      sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      return;
    }

    let raw;
    try {
      raw = await readBody(req, config.maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        sendJson(res, 413, { error: "payload_too_large" }, { connection: "close" });
        return;
      }
      throw error;
    }

    let group;
    try {
      group = normalizePayload(JSON.parse(raw.toString("utf8")));
    } catch (error) {
      if (error instanceof PayloadError || error instanceof SyntaxError) {
        logger({ event: "rejected", reason: "payload", detail: error.message });
        sendJson(res, 400, { error: "invalid_payload", detail: error.message });
        return;
      }
      throw error;
    }

    // The batch is capped again here: Alertmanager's max_alerts is one sender's
    // promise, and a hand-written POST should not be able to fan out unbounded.
    const capped = { ...group, alerts: group.alerts.slice(0, config.maxAlerts) };
    const { fresh, suppressed, at } = dedupe.partition(capped.alerts);
    if (fresh.length === 0) {
      logger({ event: "suppressed", alerts: suppressed.length, cooldown_seconds: config.cooldownSeconds });
      sendJson(res, 202, { status: "suppressed", delivered: 0, suppressed: suppressed.length });
      return;
    }

    const delivered = { ...capped, alerts: fresh, status: fresh.some((alert) => alert.status === "firing") ? "firing" : "resolved" };
    const prompt = renderPrompt(delivered, config);
    let result;
    try {
      result = await deliverToHermes({
        config,
        group: delivered,
        prompt,
        fingerprints: fresh.map((alert) => alert.fingerprint),
        fetchImpl,
        now,
      });
    } catch (error) {
      // Timeout or connection refused: retryable, so Alertmanager keeps trying.
      logger({ event: "delivery_failed", reason: "unreachable", detail: error.message });
      sendJson(res, 503, { error: "delivery_unavailable" });
      return;
    }

    if (!result.ok) {
      logger({ event: "delivery_failed", reason: "rejected", upstream_status: result.status });
      sendJson(res, 502, { error: "delivery_rejected", upstream_status: result.status });
      return;
    }

    // Record only after Hermes accepted, so a failed delivery is retried.
    dedupe.record(fresh, at);
    if (dedupe.size > 4_096) dedupe.prune(at);
    logger({
      event: "delivered",
      status: delivered.status,
      delivered: fresh.length,
      suppressed: suppressed.length,
      fingerprints: fresh.map((alert) => alert.fingerprint),
    });
    sendJson(res, 202, { status: "delivered", delivered: fresh.length, suppressed: suppressed.length });
  }

  async function handler(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url ?? "/", "http://receiver").pathname;
    } catch {
      sendJson(res, 400, { error: "bad_request" });
      return;
    }

    if (pathname === config.healthPath) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "method_not_allowed" }, { allow: "GET" });
        return;
      }
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (pathname !== config.path) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
      return;
    }

    await handleAlerts(req, res);
  }

  const server = createHttpServer((req, res) => {
    handler(req, res).catch((error) => {
      logger({ event: "error", detail: error?.message ?? String(error) });
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
      else res.destroy();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  return { config, server, dedupe, handler };
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  let receiver;
  try {
    receiver = createAlertReceiver();
  } catch (error) {
    process.stderr.write(`hermes-alert-receiver: ${error.message}\n`);
    process.exit(1);
  }
  const { config, server } = receiver;
  server.listen(config.port, config.host, () => {
    process.stdout.write(
      `${JSON.stringify({
        event: "listening",
        host: config.host,
        port: config.port,
        path: config.path,
        cooldown_seconds: config.cooldownSeconds,
        hermes_webhook_url: config.hermesWebhookUrl,
      })}\n`,
    );
  });
  const shutdown = (signal) => {
    process.stdout.write(`${JSON.stringify({ event: "shutdown", signal })}\n`);
    server.close(() => process.exit(0));
    // A hung keep-alive connection must not hold the pod past terminationGrace.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
