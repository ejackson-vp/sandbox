/**
 * Structured logging with hard rules:
 *  - never log request or response bodies
 *  - never log capabilities, payment payloads, envelopes, code or output
 *  - only log ciphertext sizes and metadata
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? "info"] ?? 20;

const REDACT_KEYS = new Set([
  "capability",
  "authorization",
  "signature",
  "envelope",
  "code",
  "stdout",
  "stderr",
  "payment-signature",
  "payment-required",
  "payment-response",
  "guesttoken",
  "token",
  "admintoken",
  "proxytoken",
  "x-sandbox-capability",
  "evidence",
  "attestation",
]);

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[depth]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACT_KEYS.has(k.toLowerCase())) out[k] = "[redacted]";
    else out[k] = sanitize(v, depth + 1);
  }
  return out;
}

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    service: process.env.SERVICE_NAME ?? "control-plane",
    msg,
    ...(fields ? (sanitize(fields) as Record<string, unknown>) : {}),
  };
  const text = JSON.stringify(line);
  if (level === "error" || level === "warn") process.stderr.write(text + "\n");
  else process.stdout.write(text + "\n");
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
