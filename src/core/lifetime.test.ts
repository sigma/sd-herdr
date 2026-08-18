import { describe, expect, it } from "vitest";

import type { Snapshot } from "../herdr/snapshot.js";
import { fixture } from "../testing/fixtures.js";
import { isRestart, terminalsOf } from "./lifetime.js";

const terminals = (name: Parameters<typeof fixture>[0]) => terminalsOf(fixture(name));

describe("terminalsOf", () => {
  it("maps every pane to the terminal it is running under", () => {
    expect([...terminals("blocked-one")]).toEqual([
      ["w0:p1", "term_aaa0000000001"],
      ["w1:p1", "term_aaa0000000002"],
    ]);
  });

  it("reads panes, not agents, so it survives an empty attention set", () => {
    // The boundary's first observable is `agents[]` emptying. A map built from
    // the agent list would go blind at exactly the moment it is needed.
    const empty = fixture("restart-empty");
    expect(empty.agents).toEqual([]);
    expect(terminalsOf(empty).size).toBe(2);
  });

  it("is empty for a snapshot that carries no panes at all", () => {
    expect(terminals("mixed-tiers").size).toBe(0);
  });
});

describe("isRestart", () => {
  it("fires when a terminal_id changes under a stable pane_id", () => {
    expect(isRestart(terminals("blocked-one"), terminals("restart-empty"))).toBe(true);
  });

  it("fires even though every agent vanished, and every seq with them", () => {
    // The two blind spots of the seq-regression rule this replaced: nothing
    // regresses when the agents are gone, and nothing regresses when the max
    // seq was already 0.
    expect(fixture("restart-empty").agents).toEqual([]);
    expect(isRestart(terminals("blocked-one"), terminals("restart-empty"))).toBe(true);
  });

  it("fires once, not again on every poll of the new lifetime", () => {
    expect(isRestart(terminals("restart-empty"), terminals("restart-redetected"))).toBe(false);
  });

  it("does not fire when nothing moved", () => {
    expect(isRestart(terminals("blocked-one"), terminals("blocked-one"))).toBe(false);
  });

  it("does not fire for a pane that is merely new, or merely gone", () => {
    const before = new Map([["w0:p1", "term_1"]]);
    expect(isRestart(before, new Map([...before, ["w9:p9", "term_9"]]))).toBe(false);
    expect(isRestart(before, new Map())).toBe(false);
  });

  it("does not fire on the first snapshot, which has nothing to compare against", () => {
    expect(isRestart(new Map(), terminals("blocked-one"))).toBe(false);
  });

  it("does not fire when the snapshot carries no panes to compare", () => {
    // A fixture trimmed of `panes[]` says nothing about lifetimes either way,
    // and saying nothing must never read as "restarted".
    const bare: Snapshot = { ...fixture("blocked-one"), panes: undefined };
    expect(isRestart(terminals("blocked-one"), terminalsOf(bare))).toBe(false);
  });
});
