import { describe, expect, it } from "vitest";

import { fixture } from "../testing/fixtures.js";
import { attentionSet } from "./attention.js";
import { type CoreEvent, type CoreState, type Effect, face, initial, reduce } from "./core.js";

/** Where the `default` session's socket lives, by herdr's path convention. */
const SOCK = "/Users/dev/.config/herdr/herdr.sock";

/**
 * Drive the core through a sequence of events, collecting what each one asked
 * for. Tests assert on this and on `face` — never on the state's shape, which
 * is the core's own business and is expected to grow with every later ticket.
 */
function drive(
  events: readonly CoreEvent[],
  state: CoreState = initial("default", SOCK),
): { state: CoreState; effects: Effect[]; last: Effect[] } {
  const all: Effect[] = [];
  let last: Effect[] = [];
  let current = state;
  for (const event of events) {
    const step = reduce(current, event);
    current = step.state;
    last = [...step.effects];
    all.push(...step.effects);
  }
  return { state: current, effects: all, last };
}

const APPEAR: CoreEvent = { type: "appeared", at: 1000 };
const snapshotAt = (at: number, name: Parameters<typeof fixture>[0]): CoreEvent => ({
  type: "snapshotTaken",
  at,
  snapshot: fixture(name),
});

describe("attentionSet", () => {
  it("is blocked ∪ done ∪ unknown-with-an-agent, and nothing else", () => {
    const set = attentionSet(fixture("mixed-tiers").agents);
    expect(set.map((a) => a.status)).toEqual(["blocked", "blocked", "done", "unknown"]);
  });

  it("excludes working and idle, however long they have waited", () => {
    // The idle agent in this fixture has the lowest seq of all — the longest
    // wait — and is still not attention: idle means "already looked at".
    const set = attentionSet(fixture("mixed-tiers").agents);
    expect(set.map((a) => a.paneId)).not.toContain("w4:p1");
  });

  it("orders by tier first, so a fresh blocked agent outranks an older done one", () => {
    const set = attentionSet(fixture("mixed-tiers").agents);
    expect(set[0]?.paneId).toBe("w3:p1"); // blocked, seq 320
    expect(set[1]?.paneId).toBe("w0:p1"); // blocked, seq 400
    expect(set[2]?.paneId).toBe("w1:p1"); // done, seq 100
    expect(set[3]?.paneId).toBe("w2:p1"); // unknown, seq 90
  });

  it("breaks ties within a tier by longest wait, not by array order", () => {
    // split-tab lists pane w0:p2 (seq 500) before w0:p7 (seq 610); both blocked.
    const set = attentionSet(fixture("split-tab").agents);
    expect(set.map((a) => a.paneId)).toEqual(["w0:p2", "w0:p7", "w1:p1"]);
  });

  it("drops an unknown pane that carries no agent", () => {
    const set = attentionSet(fixture("unknown-only").agents);
    expect(set.map((a) => a.paneId)).toEqual(["w0:p1"]);
  });

  it("is empty for a session whose agents are all idle or working", () => {
    expect(attentionSet(fixture("live-session").agents)).toEqual([]);
  });

  it("is empty for a session with no agents", () => {
    expect(attentionSet(fixture("no-agents").agents)).toEqual([]);
  });
});

describe("face", () => {
  const faceAfter = (name: Parameters<typeof fixture>[0], sessionName = "default") =>
    face(drive([APPEAR, snapshotAt(2000, name)], initial(sessionName, SOCK)).state);

  it("is red when anything is blocked", () => {
    expect(faceAfter("blocked-one").stateColour).toBe("red");
  });

  it("is red for a mixed set, even though the longest wait is a done agent", () => {
    // The bar speaks for urgency across the whole attention set.
    expect(faceAfter("mixed-tiers").stateColour).toBe("red");
  });

  it("is grey when the attention set is nothing but unknown", () => {
    // "There are agents and I cannot tell what they are doing" is the same
    // thing to a user as "I cannot see the session" — and never all-clear.
    expect(faceAfter("unknown-only").stateColour).toBe("grey");
  });

  it("is amber when the attention set is done only", () => {
    expect(faceAfter("done-only").stateColour).toBe("amber");
  });

  it("is dark when a visible session has nothing waiting", () => {
    expect(faceAfter("live-session").stateColour).toBe("dark");
    expect(faceAfter("no-agents").stateColour).toBe("dark");
  });

  it("is grey before the first snapshot arrives", () => {
    // Never "all clear": no snapshot means the plugin cannot see the session.
    expect(face(drive([APPEAR]).state).stateColour).toBe("grey");
    expect(face(initial("default", SOCK)).stateColour).toBe("grey");
  });

  it("holds its last face through a failed snapshot, rather than flinching grey", () => {
    // Grey is owed to a staleness deadline measured from the last good
    // snapshot, not to a failure count — one dropped poll is not "cannot see
    // the session". The deadline itself is #21's.
    const { state } = drive([
      APPEAR,
      snapshotAt(2000, "blocked-one"),
      { type: "snapshotFailed", at: 3000 },
    ]);
    expect(face(state).stateColour).toBe("red");
  });

  it("keeps the name it has on the plate when a snapshot fails", () => {
    const { state } = drive(
      [APPEAR, snapshotAt(2000, "blocked-one"), { type: "snapshotFailed", at: 3000 }],
      initial("work", SOCK),
    );
    expect(face(state).nameplate).toBe("work");
  });

  it("carries the session name on the nameplate", () => {
    expect(faceAfter("blocked-one", "work").nameplate).toBe("work");
  });

  it("renders the default session as herdr, which is a name the user chose", () => {
    expect(faceAfter("blocked-one", "default").nameplate).toBe("herdr");
  });

  it("falls back to herdr while grey, because it cannot verify the name", () => {
    expect(face(initial("work", SOCK)).nameplate).toBe("herdr");
  });
});

describe("reduce", () => {
  it("snapshots the session's socket as soon as the button appears", () => {
    expect(drive([APPEAR]).last).toEqual([{ type: "snapshot", socketPath: SOCK }]);
  });

  it("schedules the next poll only after a snapshot completes", () => {
    const { last } = drive([APPEAR, snapshotAt(2000, "blocked-one")]);
    expect(last).toEqual([{ type: "pollAfter", ms: 1000 }]);
  });

  it("polls the same path every time — there is nothing to re-resolve", () => {
    const { last } = drive([
      APPEAR,
      snapshotAt(2000, "blocked-one"),
      { type: "pollDue", at: 3000 },
    ]);
    expect(last).toEqual([{ type: "snapshot", socketPath: SOCK }]);
  });

  it("keeps asking on the poll cadence after a failure", () => {
    const { last } = drive([
      APPEAR,
      snapshotAt(2000, "blocked-one"),
      { type: "snapshotFailed", at: 3000 },
      { type: "pollDue", at: 4000 },
    ]);
    expect(last).toEqual([{ type: "snapshot", socketPath: SOCK }]);
  });

  it("greys out and keeps trying when the very first snapshot fails", () => {
    const { state, last } = drive([APPEAR, { type: "snapshotFailed", at: 2000 }]);
    expect(face(state).stateColour).toBe("grey");
    expect(last).toEqual([{ type: "pollAfter", ms: 1000 }]);
  });

  it("asks for nothing at all once the button is gone", () => {
    const gone = drive([APPEAR, snapshotAt(2000, "blocked-one")]);
    const after = drive(
      [
        { type: "disappeared", at: 3000 },
        { type: "pollDue", at: 4000 },
        { type: "snapshotTaken", at: 4100, snapshot: fixture("blocked-one") },
      ],
      gone.state,
    );
    expect(after.effects).toEqual([]);
  });

  it("does not start a second poll chain if it appears twice", () => {
    const { last } = drive([APPEAR, snapshotAt(2000, "blocked-one"), APPEAR]);
    expect(last).toEqual([]);
  });

  it("picks the poll chain back up when the button reappears", () => {
    const { last } = drive([
      APPEAR,
      snapshotAt(2000, "blocked-one"),
      { type: "disappeared", at: 3000 },
      { type: "appeared", at: 5000 },
    ]);
    expect(last).toEqual([{ type: "snapshot", socketPath: SOCK }]);
  });

  it("returns effects as data — the same event twice produces the same effects", () => {
    const first = drive([APPEAR, snapshotAt(2000, "blocked-one")]);
    const second = drive([APPEAR, snapshotAt(2000, "blocked-one")]);
    expect(first.effects).toEqual(second.effects);
  });

  it("reads no clock: replaying the same events later gives the same face", () => {
    const early = drive([APPEAR, snapshotAt(2000, "mixed-tiers")]);
    const late = drive([{ type: "appeared", at: 9_000_000 }, snapshotAt(9_100_000, "mixed-tiers")]);
    expect(face(late.state)).toEqual(face(early.state));
    expect(late.effects).toEqual(early.effects);
  });

  it("never mutates the state it was handed", () => {
    const before = initial("default", SOCK);
    const frozen = JSON.stringify(before);
    reduce(before, APPEAR);
    expect(JSON.stringify(before)).toBe(frozen);
  });
});
