/**
 * The create kill switch's row (schema v21).
 *
 * The store is the single source of truth, so its four rules are pinned here
 * against a real Postgres:
 *
 *  - an absent row means creates are admitted, which is what every database that
 *    upgrades through v21 looks like;
 *  - enabling writes the reason, the actor and the timestamp, and survives a
 *    controller restart because it is a row and not a process flag;
 *  - an `--until` in the past is refused rather than written, so a row can never
 *    say "on" and behave off;
 *  - an expiry turns the switch off on read, with no worker involved.
 */
import { describe, expect, it } from "vitest";
import { closeStore, freshStore, openStore, sqlRows } from "../helpers/test-store.js";

const REASON = "payment incident INC-431: facilitator is double-settling";
const ACTOR = "eric";

describe("create switch store", () => {
  it("admits creates when no row has ever been written", async () => {
    const store = await freshStore();

    const state = await store.readCreateSwitch(Date.now());

    expect(state).toEqual({
      enabled: false,
      reason: "",
      actor: "",
      changedAt: null,
      expiresAt: null,
      expired: false,
    });
    expect(await sqlRows("SELECT 1 FROM create_switch")).toHaveLength(0);
  });

  it("enables with the reason, actor and timestamp, and survives a restart", async () => {
    const store = await freshStore();
    const now = Date.now();

    const written = await store.writeCreateSwitch(
      { enabled: true, reason: REASON, actor: ACTOR, until: null },
      now,
    );
    expect(written).toMatchObject({
      ok: true,
      state: { enabled: true, reason: REASON, actor: ACTOR, expiresAt: null, expired: false },
    });

    // A restart closes the writer and opens a new one against the same rows.
    await closeStore();
    const reopened = await openStore();

    await expect(reopened.readCreateSwitch(Date.now())).resolves.toMatchObject({
      enabled: true,
      reason: REASON,
      actor: ACTOR,
      changedAt: now,
      expiresAt: null,
    });
    // One row, always: the switch is a state, not an event log.
    expect(await sqlRows("SELECT id FROM create_switch")).toEqual([{ id: 1 }]);
  });

  it("disables, keeping who turned it off and when", async () => {
    const store = await freshStore();
    await store.writeCreateSwitch({ enabled: true, reason: REASON, actor: ACTOR, until: null }, Date.now());

    const disabled = await store.writeCreateSwitch(
      { enabled: false, reason: "creates re-enabled by an operator", actor: "duty", until: null },
      Date.now(),
    );

    expect(disabled).toMatchObject({
      ok: true,
      state: { enabled: false, reason: "creates re-enabled by an operator", actor: "duty" },
    });
    await expect(store.readCreateSwitch(Date.now())).resolves.toMatchObject({
      enabled: false,
      actor: "duty",
      expired: false,
    });
  });

  it("honours an expiry without a worker: the row turns itself off", async () => {
    const store = await freshStore();
    const now = Date.now();
    const until = now + 60_000;

    await store.writeCreateSwitch({ enabled: true, reason: REASON, actor: ACTOR, until }, now);

    // Before the expiry it is on.
    await expect(store.readCreateSwitch(until - 1)).resolves.toMatchObject({
      enabled: true,
      expiresAt: until,
      expired: false,
    });
    // At the expiry instant it is off, and the row still says why and until when.
    await expect(store.readCreateSwitch(until)).resolves.toMatchObject({
      enabled: false,
      reason: REASON,
      actor: ACTOR,
      expiresAt: until,
      expired: true,
    });
  });

  it("refuses an --until that is not in the future", async () => {
    const store = await freshStore();
    const now = Date.now();

    await expect(
      store.writeCreateSwitch({ enabled: true, reason: REASON, actor: ACTOR, until: now }, now),
    ).resolves.toEqual({ ok: false, reason: "until_in_past" });
    await expect(
      store.writeCreateSwitch({ enabled: true, reason: REASON, actor: ACTOR, until: now - 1 }, now),
    ).resolves.toEqual({ ok: false, reason: "until_in_past" });

    // Nothing was written, so a past attempt cannot leave the switch on.
    expect(await sqlRows("SELECT 1 FROM create_switch")).toHaveLength(0);
    await expect(store.readCreateSwitch(now)).resolves.toMatchObject({ enabled: false });
  });
});
