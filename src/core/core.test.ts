import { describe, expect, it } from "vitest";

import { fixture } from "../testing/fixtures.js";
import { attentionSet } from "./attention.js";
import {
  type CoreEvent,
  type CoreState,
  type Effect,
  face,
  initial,
  POLL_INTERVAL_MS,
  reduce,
  SETTLE_WINDOW_MS,
  STALENESS_DEADLINE_MS,
} from "./core.js";

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
/** The heartbeat that keeps the core's clock moving while nothing else happens. */
const tickAt = (at: number): CoreEvent => ({ type: "tick", at });
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
    // the session".
    const { state } = drive([
      APPEAR,
      snapshotAt(2000, "blocked-one"),
      { type: "snapshotFailed", at: 3000 },
    ]);
    expect(face(state).stateColour).toBe("red");
  });

  it("keeps the name it has on the plate while the last snapshot is still fresh", () => {
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
    expect(drive([APPEAR]).last).toEqual([
      // The startup ping, which names the server this loop will be talking to.
      { type: "ping", socketPath: SOCK },
      { type: "snapshot", socketPath: SOCK },
      { type: "tickAfter", ms: 500 },
    ]);
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
    expect(last).toEqual([
      { type: "ping", socketPath: SOCK },
      { type: "snapshot", socketPath: SOCK },
      { type: "tickAfter", ms: 500 },
    ]);
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

describe("the staleness deadline", () => {
  /** A good snapshot at 2000, then whatever the test wants to happen after it. */
  const afterGood = (...events: CoreEvent[]) =>
    drive([APPEAR, snapshotAt(2000, "blocked-one"), ...events]).state;

  it("keeps the face while the data is younger than the deadline", () => {
    expect(face(afterGood(tickAt(4999))).stateColour).toBe("red");
  });

  it("goes grey once the last good snapshot reaches 3 s old", () => {
    expect(face(afterGood(tickAt(5000))).stateColour).toBe("grey");
  });

  it("measures the age of the data, not the count of failures", () => {
    // Four failures inside the deadline do not grey the face…
    const failing = afterGood(
      { type: "snapshotFailed", at: 2100 },
      { type: "snapshotFailed", at: 2400 },
      { type: "snapshotFailed", at: 3900 },
      { type: "snapshotFailed", at: 4900 },
    );
    expect(face(failing).stateColour).toBe("red");
    // …and one silent tick past it does, with no failure at all.
    expect(face(afterGood(tickAt(5100))).stateColour).toBe("grey");
  });

  it("retires the last good face when the session stops under it", () => {
    // A stopped session and an unreachable socket arrive as the same rejection,
    // and both end here: the face survives the first dropped polls, then ages
    // out into the same grey as a session that was never seen at all.
    const stopped = afterGood(
      { type: "snapshotFailed", at: 3000 },
      { type: "snapshotFailed", at: 4000 },
      { type: "snapshotFailed", at: 5200 },
    );
    expect(face(stopped)).toEqual({
      stateColour: "grey",
      nameplate: "herdr",
      body: "",
      pips: [],
      pipOverflow: false,
    });
  });

  it("goes grey on a poll loop that wedges without ever failing", () => {
    // The only events are heartbeats: the snapshot request never came back, so
    // there is neither a success nor a failure to count. A deadline notices
    // anyway, which is the whole reason it is a deadline.
    expect(face(afterGood(tickAt(2500), tickAt(3000), tickAt(6000))).stateColour).toBe("grey");
  });

  it("recovers as soon as a fresh snapshot lands", () => {
    expect(face(afterGood(tickAt(6000), snapshotAt(6100, "blocked-one"))).stateColour).toBe("red");
  });

  it("reads herdr on the plate once it is stale, whatever the session is called", () => {
    const { state } = drive(
      [APPEAR, snapshotAt(2000, "blocked-one"), tickAt(6000)],
      initial("work", SOCK),
    );
    expect(face(state).nameplate).toBe("herdr");
  });

  it("reads herdr on the plate for an unknown-only set, because grey is one state", () => {
    const { state } = drive([APPEAR, snapshotAt(2000, "unknown-only")], initial("work", SOCK));
    expect(face(state)).toEqual({
      stateColour: "grey",
      nameplate: "herdr",
      body: "",
      pips: [],
      pipOverflow: false,
    });
  });
});

describe("backoff", () => {
  const delays = (events: readonly CoreEvent[]) =>
    drive([APPEAR, ...events])
      .effects.filter((e) => e.type === "pollAfter")
      .map((e) => e.ms);

  const failures = (count: number): CoreEvent[] =>
    Array.from({ length: count }, (_, i) => ({ type: "snapshotFailed", at: 2000 + i * 100 }));

  it("doubles the gap on each consecutive failure, up to a 5 s ceiling", () => {
    expect(delays(failures(6))).toEqual([1000, 2000, 4000, 5000, 5000, 5000]);
  });

  it("drops back to the poll cadence as soon as a snapshot lands", () => {
    expect(delays([...failures(3), snapshotAt(3000, "blocked-one"), ...failures(1)])).toEqual([
      1000,
      2000,
      4000,
      POLL_INTERVAL_MS,
      1000,
    ]);
  });

  it("recovers without anyone touching the button", () => {
    const { state } = drive([
      APPEAR,
      ...failures(6),
      { type: "pollDue", at: 9000 },
      snapshotAt(9100, "blocked-one"),
    ]);
    expect(face(state).stateColour).toBe("red");
  });
});

describe("a press", () => {
  const PRESS: CoreEvent = { type: "pressed", at: 2500 };
  /** What one press asks for, from a session showing `name`. */
  const press = (name: Parameters<typeof fixture>[0], sessionName = "default") =>
    drive([APPEAR, snapshotAt(2000, name), PRESS], initial(sessionName, SOCK));

  it("writes the nonce, focuses, raises, then clears — in that order", () => {
    // The order is the contract, not a preference: the TUI marks the active tab
    // seen on terminal focus-in, so raising before focusing would consume a
    // done agent in the old tab the user never saw.
    expect(press("blocked-one").last.map((e) => e.type)).toEqual([
      "setTitle",
      "focusPane",
      "raise",
      "clearTitle",
    ]);
  });

  it("focuses the top-priority agent, not the first one herdr listed", () => {
    expect(press("mixed-tiers").last).toContainEqual({
      type: "focusPane",
      socketPath: SOCK,
      paneId: "w3:p1",
    });
  });

  it("raises under the same nonce it wrote, so the raise can find the window", () => {
    const [set, , raise] = press("blocked-one").last;
    expect(set).toEqual({ type: "setTitle", socketPath: SOCK, nonce: expect.any(String) });
    expect(raise).toEqual({ type: "raise", nonce: (set as { nonce: string }).nonce });
  });

  it("uses a nonce a human can live with finding stranded in a title bar", () => {
    // A client dying mid-press strands it permanently — `clear` then answers
    // no_foreground_client — so the user has to recognise it and clear it by hand.
    const { last } = press("blocked-one", "work");
    const nonce = (last[0] as { nonce: string }).nonce;
    expect(nonce).toBe("sd-herdr raise work #1");
  });

  it("counts presses, so two in flight do not answer to the same title", () => {
    const { effects } = drive([APPEAR, snapshotAt(2000, "blocked-one"), PRESS, PRESS]);
    const nonces = effects.filter((e) => e.type === "raise").map((e) => e.nonce);
    expect(nonces).toEqual(["sd-herdr raise default #1", "sd-herdr raise default #2"]);
  });

  it("raises and focuses nothing when nothing is waiting", () => {
    // The raise still happens: the user asked to be taken to the session.
    expect(press("no-agents").last.map((e) => e.type)).toEqual(["setTitle", "raise", "clearTitle"]);
  });

  it("raises and focuses nothing while grey, never acting on data it distrusts", () => {
    const blind = drive([APPEAR, { type: "pressed", at: 2000 }]).last;
    expect(blind.map((e) => e.type)).toEqual(["setTitle", "raise", "clearTitle"]);

    const stale = drive([APPEAR, snapshotAt(2000, "blocked-one"), { type: "pressed", at: 6000 }]);
    expect(stale.last.map((e) => e.type)).toEqual(["setTitle", "raise", "clearTitle"]);
  });

  it("will not speak for an unknown agent, which is what its grey says", () => {
    expect(press("unknown-only").last.map((e) => e.type)).toEqual([
      "setTitle",
      "raise",
      "clearTitle",
    ]);
  });

  it("re-reads the session after every focus, because one press can consume several", () => {
    // Focusing any pane clears herdr's `seen` for every pane in that tab, so
    // the post-press attention set is not something the core can predict.
    const { last } = drive([
      APPEAR,
      snapshotAt(2000, "blocked-one"),
      PRESS,
      { type: "focusResult", at: 2600, ok: true },
    ]);
    expect(last).toEqual([{ type: "snapshot", socketPath: SOCK }]);
  });

  it("re-snapshots and stops when the pane died between the poll and the press", () => {
    // pane_not_found: no in-press retry, no second focus. The raise already
    // went out with the rest of the press, so the window still comes forward.
    const { last } = drive([
      APPEAR,
      snapshotAt(2000, "blocked-one"),
      PRESS,
      { type: "focusResult", at: 2600, ok: false },
    ]);
    expect(last).toEqual([{ type: "snapshot", socketPath: SOCK }]);
  });
});

describe("the press cycle", () => {
  const pressAt = (at: number): CoreEvent => ({ type: "pressed", at });

  /** Which panes a run of events actually put the cursor in, in order. */
  const focused = (effects: readonly Effect[]): string[] =>
    effects.filter((e) => e.type === "focusPane").map((e) => e.paneId);

  /** `count` presses against one unchanging snapshot, a tenth of a second apart. */
  const presses = (name: Parameters<typeof fixture>[0], count: number): string[] =>
    focused(
      drive([
        APPEAR,
        snapshotAt(2000, name),
        ...Array.from({ length: count }, (_, i) => pressAt(2100 + i * 100)),
      ]).effects,
    );

  it("visits successive attention panes in priority order", () => {
    expect(presses("mixed-tiers", 4)).toEqual(["w3:p1", "w0:p1", "w1:p1", "w2:p1"]);
  });

  it("gives each of two agents tiled in one tab its own press", () => {
    // Stepping is pane-granular over a pane-keyed visited set. Tab-granular
    // stepping would mark w0:p7 visited on the press that reached w0:p2 and
    // leave it unreachable by button — in exactly the case the button exists
    // for, since spawning agents from agents is the point of herdr.
    expect(presses("split-tab", 3)).toEqual(["w0:p2", "w0:p7", "w1:p1"]);
  });

  it("wraps back to the top once every attention pane has been visited", () => {
    expect(presses("mixed-tiers", 6)).toEqual([
      "w3:p1",
      "w0:p1",
      "w1:p1",
      "w2:p1",
      // Wrapped — and without spending a press on the wrap itself.
      "w3:p1",
      "w0:p1",
    ]);
  });

  it("keeps walking when a new agent arrives mid-cycle, rather than starting over", () => {
    // The visited set is pruned, never reset on membership change. An earlier
    // design reset it here, and that rule was the sole cause of done-tier
    // starvation: it walked the user back through agents they had just seen.
    const { effects } = drive([
      APPEAR,
      snapshotAt(2000, "done-pair"),
      pressAt(2100),
      snapshotAt(2200, "done-pair-newcomer"),
      pressAt(2300),
    ]);
    expect(focused(effects)).toEqual(["w0:p1", "w0:p2"]);
  });

  it("prunes a pane that leaves the attention set, so it is reachable when it returns", () => {
    // w0:p1 is visited, then leaves, then comes back. A stale entry would skip
    // it — the pane is new to this cycle again, because the cycle never saw it.
    const { effects } = drive([
      APPEAR,
      snapshotAt(2000, "done-pair"),
      pressAt(2100),
      snapshotAt(2200, "done-pair-consumed"),
      pressAt(2300),
      snapshotAt(2400, "done-pair"),
      pressAt(2500),
    ]);
    expect(focused(effects)).toEqual(["w0:p1", "w1:p1", "w0:p1"]);
  });

  it("discards the visited set when the button goes away", () => {
    const { effects } = drive([
      APPEAR,
      snapshotAt(2000, "mixed-tiers"),
      pressAt(2100),
      { type: "disappeared", at: 2200 },
      { type: "appeared", at: 2300 },
      snapshotAt(2400, "mixed-tiers"),
      pressAt(2500),
    ]);
    expect(focused(effects)).toEqual(["w3:p1", "w3:p1"]);
  });

  it("has no idle-timeout reset: a long quiet gap does not walk the user back", () => {
    // The only resets are wrap, willDisappear and a detected server restart.
    // A timer here would layer invisible state on invisible state and march the
    // user back through blocked tabs they have already answered.
    const quiet = Array.from({ length: 60 }, (_, i) => snapshotAt(3000 + i * 1000, "mixed-tiers"));
    const { effects } = drive([
      APPEAR,
      snapshotAt(2000, "mixed-tiers"),
      pressAt(2100),
      ...quiet,
      pressAt(63_000),
    ]);
    expect(focused(effects)).toEqual(["w3:p1", "w0:p1"]);
  });

  it("un-visits a pane the focus never reached, because it took the user nowhere", () => {
    const { effects } = drive([
      APPEAR,
      snapshotAt(2000, "mixed-tiers"),
      pressAt(2100),
      { type: "focusResult", at: 2200, ok: false },
      snapshotAt(2300, "mixed-tiers"),
      pressAt(2400),
    ]);
    expect(focused(effects)).toEqual(["w3:p1", "w3:p1"]);
  });

  it("leaves the visited set alone on a press it declined to aim", () => {
    // Grey means the plugin does not trust what it knows; recording a visit
    // that never happened would spend a cycle step on it.
    const { effects } = drive([
      APPEAR,
      snapshotAt(2000, "mixed-tiers"),
      { type: "pressed", at: 6000 },
      snapshotAt(6100, "mixed-tiers"),
      pressAt(6200),
    ]);
    expect(focused(effects)).toEqual(["w3:p1"]);
  });

  it("consumes every done agent in the tab it lands in, leaving the second unreachable", () => {
    // Asserted as intended behaviour, not tolerated as a bug. Focusing any pane
    // calls herdr's mark_active_tab_seen(), which clears `seen` for every pane
    // in that tab — and `done` is (idle, seen = false). So the press that
    // reaches w0:p1 consumes w0:p2 as well, and no press ever lands there.
    // The face gives no warning: the cost is one the user cannot avoid.
    const { effects } = drive([
      APPEAR,
      snapshotAt(2000, "done-pair"),
      pressAt(2100),
      { type: "focusResult", at: 2200, ok: true },
      snapshotAt(2300, "done-pair-consumed"),
      pressAt(2400),
      pressAt(2500),
    ]);
    expect(focused(effects)).not.toContain("w0:p2");
    expect(focused(effects)).toEqual(["w0:p1", "w1:p1", "w1:p1"]);
  });
});

describe("the body", () => {
  const pressAt = (at: number): CoreEvent => ({ type: "pressed", at });

  /** The face after `count` presses against one unchanging snapshot. */
  const stepped = (name: Parameters<typeof fixture>[0], count: number) =>
    face(
      drive([
        APPEAR,
        snapshotAt(2000, name),
        ...Array.from({ length: count }, (_, i) => pressAt(2100 + i * 100)),
      ]).state,
    );

  it("names where the next press goes, and changes as you step", () => {
    // Not the top-priority agent, which never moves: focusing a blocked agent
    // consumes nothing, so a face naming it would sit inert for a whole cycle.
    expect([0, 1, 2, 3].map((n) => stepped("mixed-tiers", n).body)).toEqual([
      "playpen",
      "nix",
      "trunk",
      "infra",
    ]);
  });

  it("renders a bare workspace label for one agent alone in its tab", () => {
    expect(stepped("blocked-one", 0).body).toBe("nix");
  });

  it("adds a pane index when an attention sibling shares the tab", () => {
    expect(stepped("split-tab", 0).body).toBe("trunk ①");
    expect(stepped("split-tab", 1).body).toBe("trunk ③");
  });

  it("counts panes rather than agents, so agent | shell | agent reads ① and ③", () => {
    expect(stepped("split-tab", 1).body).toBe("trunk ③");
  });

  it("leaves the label bare when only a plain shell shares the tab", () => {
    // The lone agent of w1:t1, and — after the split tab is walked — the split
    // tab's own survivor.
    expect(stepped("split-tab", 2).body).toBe("nix");
  });

  it("blinks the index away when the sibling stops waiting", () => {
    // Paying only where it is needed, working as intended: the same pane in the
    // same three-pane tab, now the only one waiting in it.
    expect(stepped("split-tab-lone", 0).body).toBe("trunk");
  });

  it("says nothing when there is nowhere for a press to go", () => {
    expect(stepped("no-agents", 0).body).toBe("");
    expect(face(initial("work", SOCK)).body).toBe("");
  });

  it("is allowed to disagree with the bar about tier", () => {
    // A red bar over an amber-tier body is correct, not a bug: the bar is
    // global and is the only thing left saying something is blocked somewhere,
    // while the body follows the button. Two presses in, the cycle has walked
    // past both blocked agents and the next press goes to a `done` one.
    const amberTarget = stepped("mixed-tiers", 2);
    expect(amberTarget).toMatchObject({ stateColour: "red", body: "trunk" });
  });
});

describe("the pips", () => {
  const pipsAfter = (name: Parameters<typeof fixture>[0]) =>
    face(drive([APPEAR, snapshotAt(2000, name)]).state);

  it("shows the other waiters, tier-coloured, in priority order", () => {
    expect(pipsAfter("mixed-tiers").pips).toEqual(["red", "amber", "grey"]);
  });

  it("never gives the named agent a pip, so body and pips do not restate each other", () => {
    // blocked-one has exactly one waiter, and the body names it.
    expect(pipsAfter("blocked-one")).toMatchObject({ body: "nix", pips: [] });
  });

  it("stops counting past the cap and says … instead", () => {
    const face = pipsAfter("many-waiters");
    expect(face.pips).toEqual(["red", "red", "red", "red"]);
    expect(face.pipOverflow).toBe(true);
  });

  it("has no pips when nothing is waiting, and none while grey", () => {
    expect(pipsAfter("no-agents")).toMatchObject({ pips: [], pipOverflow: false });
    expect(pipsAfter("unknown-only")).toMatchObject({ pips: [], pipOverflow: false });
  });
});

describe("settling after a server restart", () => {
  /** A good snapshot, then a boundary at 3000, then whatever the test wants. */
  const acrossBoundary = (...events: CoreEvent[]) =>
    drive([APPEAR, snapshotAt(2000, "blocked-one"), snapshotAt(3000, "restart-empty"), ...events]);

  it("detects the restart from a terminal_id that changed under a stable pane_id", () => {
    // Nothing else moved: the panes are the same panes, under the same ids.
    expect(face(acrossBoundary().state).stateColour).toBe("grey");
  });

  it("detects it even though every agent vanished and every seq with them", () => {
    // The two cases the earlier seq-regression rule could not see. The
    // snapshot in hand has no agents at all, and would render dark.
    expect(fixture("restart-empty").agents).toEqual([]);
    expect(face(acrossBoundary().state).stateColour).toBe("grey");
  });

  /** The polls that keep coming during the hold — the data is never the reason it is grey. */
  const polling = (...at: number[]): CoreEvent[] => at.map((t) => snapshotAt(t, "restart-empty"));

  it("holds grey for four seconds, then trusts the data regardless", () => {
    // The snapshots keep landing and keep saying "no agents". The hold, not
    // the staleness deadline, is what makes this grey.
    expect(face(acrossBoundary(...polling(4000, 5000, 6000, 6900)).state).stateColour).toBe("grey");
    // The window ends on a fixed timer, not on the data agreeing — after a
    // stop/restart the data never will, and a dark tile is then honest.
    expect(face(acrossBoundary(...polling(4000, 5000, 6000, 7000)).state).stateColour).toBe("dark");
  });

  it("settles to dark after a stop/restart, where nothing ever comes back", () => {
    const dead = acrossBoundary(
      snapshotAt(4000, "restart-empty"),
      snapshotAt(5000, "restart-empty"),
      snapshotAt(6000, "restart-empty"),
      snapshotAt(7000, "restart-empty"),
    );
    expect(face(dead.state)).toMatchObject({ stateColour: "dark", body: "" });
  });

  it("is correct again once a live handoff has re-detected its agents", () => {
    // Agents reappear at ~0.4 s but correct statuses only at ~3.74 s, so the
    // window is sized for the second number, not the first.
    const back = acrossBoundary(snapshotAt(6800, "restart-redetected"));
    expect(face(back.state).stateColour).toBe("grey");
    expect(face(drive([tickAt(7000)], back.state).state).stateColour).toBe("red");
  });

  it("does not settle again on every poll of the new lifetime", () => {
    // One boundary, one hold: a rotation detected twice would restart the
    // window forever and pin the tile grey.
    const settled = acrossBoundary(
      snapshotAt(4000, "restart-redetected"),
      snapshotAt(5000, "restart-redetected"),
      tickAt(7000),
    );
    expect(face(settled.state).stateColour).toBe("red");
  });

  it("sizes the hold from its own constant, not the staleness deadline", () => {
    // Two deadlines answering two questions. Sharing one constant would make a
    // change to either a silent change to the other.
    expect(SETTLE_WINDOW_MS).toBe(4000);
    expect(SETTLE_WINDOW_MS).not.toBe(STALENESS_DEADLINE_MS);
  });

  it("pings on the restart, and on nothing else in between", () => {
    const { effects } = acrossBoundary(
      snapshotAt(4000, "restart-empty"),
      { type: "pollDue", at: 5000 },
      snapshotAt(5100, "restart-redetected"),
    );
    // Two: the one at startup, and the one for the boundary. Never per poll.
    expect(effects.filter((e) => e.type === "ping")).toEqual([
      { type: "ping", socketPath: SOCK },
      { type: "ping", socketPath: SOCK },
    ]);
  });

  it("clears the visited set, because the agents behind those panes are new", () => {
    const { effects } = drive([
      APPEAR,
      snapshotAt(2000, "blocked-one"),
      { type: "pressed", at: 2100 },
      snapshotAt(3000, "restart-empty"),
      snapshotAt(6000, "restart-redetected"),
      snapshotAt(7100, "restart-redetected"),
      { type: "pressed", at: 7200 },
    ]);
    // w0:p1 was visited before the boundary and is reachable again after it.
    expect(effects.filter((e) => e.type === "focusPane").map((e) => e.paneId)).toEqual([
      "w0:p1",
      "w0:p1",
    ]);
  });

  it("aims a press at nothing while it is settling", () => {
    // Settling is grey, and grey never acts on data the plugin distrusts.
    const { last } = acrossBoundary(snapshotAt(4000, "restart-redetected"), {
      type: "pressed",
      at: 4100,
    });
    expect(last.map((e) => e.type)).toEqual(["setTitle", "raise", "clearTitle"]);
  });
});

describe("the heartbeat", () => {
  it("keeps beating while the button is on screen", () => {
    expect(drive([APPEAR, tickAt(1500)]).last).toEqual([{ type: "tickAfter", ms: 500 }]);
  });

  it("stops with the button, so an invisible tile costs nothing", () => {
    const { last } = drive([APPEAR, { type: "disappeared", at: 2000 }, tickAt(2500)]);
    expect(last).toEqual([]);
  });

  it("does not itself ask herdr for anything", () => {
    const { effects } = drive([APPEAR, snapshotAt(2000, "blocked-one"), tickAt(2500)]);
    expect(effects.filter((e) => e.type === "snapshot")).toHaveLength(1);
  });
});
