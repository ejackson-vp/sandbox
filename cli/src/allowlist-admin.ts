/**
 * `sandbox admin` — controller operational commands.
 *
 * These use the existing `CONTROLLER_ADMIN_TOKEN`, the same credential the
 * controller's other internal routes accept. There is no new long-lived
 * credential: the CLI holds the operator's token for one request and sends
 * nothing else.
 *
 * `admin capacity` moved here unchanged. `admin allowlist` manages the free
 * entitlement list (ADR 0013) and validates its inputs before calling the
 * controller, so a typo costs no round trip and cannot create a half-valid row.
 * `admin killswitch` is the emergency stop (schema v21): it writes one durable
 * row that refuses new creates and touches no live session, so an `--until` in
 * the past and a missing `--reason` are refused here rather than at the
 * controller.
 */

export const ADMIN_USAGE = `usage:
  sandbox admin capacity
  sandbox admin allowlist [list]
  sandbox admin allowlist add <address> --label <name> [--max-tier short|standard|extended|long] [--max-concurrent N]
  sandbox admin allowlist disable <address>
  sandbox admin killswitch [status]
  sandbox admin killswitch enable --reason <text> [--until <iso8601|none>] [--actor <name>]
  sandbox admin killswitch disable [--actor <name>]
`;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TIERS = new Set(["short", "standard", "extended", "long"]);
/** An ISO 8601 instant with an offset: `--until 2026-11-16T08:00:00Z`. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_REASON = 280;
const MAX_ACTOR = 64;

export interface AdminIo {
  /** Writes one machine-readable result (already JSON-formatted). */
  out(text: string): void;
  /** Writes one operator-facing error line. */
  err(text: string): void;
}

function controllerBase(): string {
  return process.env.CONTROLLER_URL ?? "http://localhost:3001";
}

function adminToken(): string {
  return process.env.CONTROLLER_ADMIN_TOKEN ?? process.env.ADMIN_TOKEN ?? "";
}

async function call(path: string, init: RequestInit = {}): Promise<{ ok: boolean; body: unknown }> {
  const response = await fetch(new URL(path, controllerBase()), {
    ...init,
    headers: {
      // Only when there is a body, so a read request looks exactly like the
      // capacity read it replaced.
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      "x-internal-token": adminToken(),
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, body };
}

function print(io: AdminIo, body: unknown): void {
  io.out(`${JSON.stringify(body, null, 2)}\n`);
}

/** Parse `--max-concurrent`, refusing anything the controller would refuse. */
function parseMaxConcurrent(raw: unknown): number | null {
  if (raw === undefined) return 1;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
}

/**
 * Who is flipping the switch. The token is the credential; this is the audit
 * string the next operator reads, so it defaults to the login name and can be
 * overridden with `--actor` when a shared laptop or a break-glass account is
 * used.
 */
function actor(values: Record<string, unknown>): string | null {
  const raw = typeof values.actor === "string" ? values.actor.trim() : "";
  const name = raw === "" ? (process.env.USER ?? process.env.USERNAME ?? "") : raw;
  return name !== "" && name.length <= MAX_ACTOR ? name : null;
}

/**
 * `--until`: absent or `none` means "until disabled". An instant in the past is
 * an operator mistake, so it is refused here as well as at the controller: a row
 * that says "on" and behaves off is the one shape `status` cannot explain.
 */
function parseUntil(raw: unknown): { ok: true; until: string | null } | { ok: false } {
  if (raw === undefined || raw === "none") return { ok: true, until: null };
  const text = String(raw);
  if (!ISO_INSTANT.test(text) || !Number.isFinite(Date.parse(text))) return { ok: false };
  if (Date.parse(text) <= Date.now()) return { ok: false };
  return { ok: true, until: new Date(Date.parse(text)).toISOString() };
}

export async function runAdmin(
  args: string[],
  values: Record<string, unknown>,
  io: AdminIo,
): Promise<number> {
  const [section, action, target] = args;

  if (section === "capacity" && action === undefined) {
    const { ok, body } = await call("/internal/capacity");
    print(io, body);
    return ok ? 0 : 1;
  }

  if (section === "allowlist") {
    if (action === undefined || action === "list") {
      const { ok, body } = await call("/internal/payer-allowlist");
      print(io, body);
      return ok ? 0 : 1;
    }

    if (action === "add") {
      if (!target || !ADDRESS.test(target)) {
        io.err(`invalid address: ${target ?? ""}\n`);
        return 2;
      }
      const label = typeof values.label === "string" ? values.label.trim() : "";
      if (!label || label.length > 64) {
        io.err("--label is required and must be 1-64 characters\n");
        return 2;
      }
      const maxTier = typeof values["max-tier"] === "string" ? values["max-tier"] : "standard";
      if (!TIERS.has(maxTier)) {
        io.err(`invalid --max-tier: ${maxTier}\n`);
        return 2;
      }
      const maxConcurrent = parseMaxConcurrent(values["max-concurrent"]);
      if (maxConcurrent === null) {
        io.err("--max-concurrent must be an integer between 0 and 100\n");
        return 2;
      }
      const { ok, body } = await call("/internal/payer-allowlist", {
        method: "PUT",
        body: JSON.stringify({ address: target, label, maxTier, maxConcurrent }),
      });
      print(io, body);
      return ok ? 0 : 1;
    }

    if (action === "disable") {
      if (!target || !ADDRESS.test(target)) {
        io.err(`invalid address: ${target ?? ""}\n`);
        return 2;
      }
      const { ok, body } = await call(`/internal/payer-allowlist/${target}`, { method: "DELETE" });
      print(io, body);
      return ok ? 0 : 1;
    }
  }

  if (section === "killswitch") {
    if (action === undefined || action === "status") {
      const { ok, body } = await call("/internal/create-switch");
      print(io, body);
      return ok ? 0 : 1;
    }

    if (action === "enable") {
      const reason = typeof values.reason === "string" ? values.reason.trim() : "";
      if (!reason || reason.length > MAX_REASON) {
        io.err(`--reason is required and must be 1-${MAX_REASON} characters\n`);
        return 2;
      }
      const who = actor(values);
      if (who === null) {
        io.err(`--actor must be 1-${MAX_ACTOR} characters, or set $USER\n`);
        return 2;
      }
      const until = parseUntil(values.until);
      if (!until.ok) {
        io.err("--until must be an ISO 8601 instant in the future, or none\n");
        return 2;
      }
      const { ok, body } = await call("/internal/create-switch", {
        method: "PUT",
        body: JSON.stringify({ reason, actor: who, until: until.until }),
      });
      print(io, body);
      return ok ? 0 : 1;
    }

    if (action === "disable") {
      const who = actor(values);
      if (who === null) {
        io.err(`--actor must be 1-${MAX_ACTOR} characters, or set $USER\n`);
        return 2;
      }
      const { ok, body } = await call("/internal/create-switch", {
        method: "DELETE",
        body: JSON.stringify({ actor: who }),
      });
      print(io, body);
      return ok ? 0 : 1;
    }
  }

  io.err(ADMIN_USAGE);
  return 2;
}
