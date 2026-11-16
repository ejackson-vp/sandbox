/**
 * The session's operational timings blob.
 *
 * `sessions.timings_json` is a flat map of epoch-millisecond stamps and small
 * counters the provisioning paths write as they go (queue entry, warm pick, pod
 * create). It is telemetry, not domain state: no transition is decided from it,
 * each reader asks for the one key it needs, and an absent column is an empty
 * blob rather than an error.
 *
 * One reader, so "absent means empty" lives in one place. A malformed value
 * still throws: the column is written by this service with `JSON.stringify` of
 * a filtered number map, so a parse failure is a bug, not an input.
 */
import type { SessionRecord } from "./store/models.js";

export function sessionTimings(
  session: Pick<SessionRecord, "timingsJson">,
): Record<string, unknown> {
  return session.timingsJson ? (JSON.parse(session.timingsJson) as Record<string, unknown>) : {};
}
