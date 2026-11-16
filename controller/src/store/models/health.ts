/**
 * The store's readiness answer.
 *
 * The probe keeps its own SQL and reason matching, so only the shape is shared
 * between the adapter and the readiness route.
 */
export type StoreHealth =
  | { ok: true; schemaVersion: number }
  | {
      ok: false;
      reason: "unavailable" | "closed" | "migrations_incomplete" | "read_only" | "locked" | "write_failed";
      schemaVersion?: number;
    };