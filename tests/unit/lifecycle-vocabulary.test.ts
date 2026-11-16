/**
 * One state vocabulary, derived everywhere.
 *
 * Five modules used to keep their own copy of "terminal": the capacity reaper,
 * the pod sweep, the refund policy, the store's session readers and the
 * checkpoint-retention decision. The last one is the one that costs something: a
 * terminal state missing from it means a plaintext checkpoint volume that no
 * sweep ever deletes. So the sets are derived from `SESSION_STATES` and
 * `TERMINAL_STATES`, and this file pins the derivations.
 *
 * Adding a state here is the point. If it is terminal and no termination reason
 * can produce it, these fail; if the SQL body or the finalisable set drifts from
 * the list, these fail. Deriving the sets is what makes the rest of the
 * controller follow without edits.
 */
import { describe, expect, it } from "vitest";
import {
  NON_TERMINAL_STATES,
  NON_TERMINAL_STATE_SQL,
  SESSION_STATES,
  TERMINAL_STATES,
  TERMINAL_STATE_SQL,
  isTerminal,
  stateListSql,
} from "../../shared/src/protocol/lifecycle.js";
import { finalStateForReason } from "../../shared/src/domain/session.js";

/** The state literals in a generated `IN` body, in source order. */
function literals(sql: string): string[] {
  return [...sql.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]!);
}

describe("lifecycle vocabulary", () => {
  it("splits SESSION_STATES into terminal and non-terminal exactly once each", () => {
    const listed = [...TERMINAL_STATES, ...NON_TERMINAL_STATES];
    // No state in both halves, no state in neither, no duplicate.
    expect(new Set(listed).size).toBe(SESSION_STATES.length);
    expect([...listed].sort()).toEqual([...SESSION_STATES].sort());

    for (const state of SESSION_STATES) {
      expect(isTerminal(state), state).toBe(TERMINAL_STATES.includes(state));
    }
  });

  it("generates both SQL bodies from the lists, with nothing else in them", () => {
    expect(literals(TERMINAL_STATE_SQL)).toEqual([...TERMINAL_STATES]);
    expect(literals(NON_TERMINAL_STATE_SQL)).toEqual([...NON_TERMINAL_STATES]);
    for (const state of [...literals(TERMINAL_STATE_SQL), ...literals(NON_TERMINAL_STATE_SQL)]) {
      expect(SESSION_STATES).toContain(state);
    }
    // The generator itself is pinned, not just today's two strings.
    expect(literals(stateListSql(SESSION_STATES))).toEqual([...SESSION_STATES]);
  });

  it("can finalise every terminal state from a termination reason", () => {
    // Every path to a final row goes through `finalStateForReason`, so a
    // terminal state no reason maps to is a state a session can never reach.
    const reasons = ["lease_expired", "failure:provisioning_timeout", "client_destroy", "unknown"];
    const reachable = new Set(reasons.map(finalStateForReason));
    expect([...reachable].sort()).toEqual([...TERMINAL_STATES].sort());
    for (const state of reachable) expect(isTerminal(state)).toBe(true);
  });
});
