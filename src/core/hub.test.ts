import { describe, expect, it } from "vitest";

import type { FaceDescriptor } from "../face/descriptor.js";
import type { Snapshot } from "../herdr/snapshot.js";
import { fixture } from "../testing/fixtures.js";
import { SessionHub, type SharedAdapters, type Subscriber } from "./hub.js";

const SOCK = "/Users/dev/.config/herdr/herdr.sock";
const OTHER = "/Users/dev/.config/herdr/sessions/work/herdr.sock";

/** A world the test drives: no sleeping, no sockets, every call recorded. */
function world(snapshotFor: (socketPath: string) => Snapshot = () => fixture("mixed-tiers")) {
  const calls: string[] = [];
  let timers: { ms: number; fn: () => void }[] = [];
  let clock = 1000;

  const adapters: SharedAdapters = {
    async snapshot(socketPath) {
      calls.push(`snapshot:${socketPath}`);
      return snapshotFor(socketPath);
    },
    async ping(socketPath) {
      calls.push(`ping:${socketPath}`);
    },
    async setTitle(_socketPath, nonce) {
      calls.push(`setTitle:${nonce}`);
    },
    async clearTitle() {
      calls.push("clearTitle");
    },
    async focusPane(_socketPath, paneId) {
      calls.push(`focusPane:${paneId}`);
    },
    now: () => clock,
    report(message) {
      calls.push(`report:${message}`);
    },
    schedule(ms, fn) {
      const timer = { ms, fn };
      timers.push(timer);
      return {
        cancel() {
          timers = timers.filter((t) => t !== timer);
        },
      };
    },
  };

  return {
    adapters,
    calls,
    /** One button, recording what it was asked to draw and to raise. */
    button(name: string) {
      const painted: FaceDescriptor[] = [];
      const subscriber: Subscriber = {
        paint(face) {
          painted.push(face);
        },
        async raise(nonce) {
          calls.push(`raise:${name}:${nonce}`);
        },
      };
      return { ...subscriber, subscriber, painted };
    },
    fireTimers() {
      const due = timers;
      timers = [];
      clock += 1000;
      for (const t of due) t.fn();
    },
    settle: () => new Promise((r) => setImmediate(r)),
  };
}

const focuses = (calls: readonly string[]) =>
  calls.filter((c) => c.startsWith("focusPane:")).map((c) => c.slice("focusPane:".length));

describe("SessionHub", () => {
  it("polls once for two buttons watching the same session", async () => {
    const w = world();
    const hub = new SessionHub(w.adapters);
    const one = w.button("one");
    const two = w.button("two");

    hub.join("default", SOCK, one.subscriber);
    hub.join("default", SOCK, two.subscriber);
    await w.settle();
    w.fireTimers();
    await w.settle();

    expect(hub.loops).toBe(1);
    expect(w.calls.filter((c) => c.startsWith("snapshot:"))).toEqual([
      `snapshot:${SOCK}`,
      `snapshot:${SOCK}`,
    ]);
  });

  it("draws the same face on both of them", async () => {
    const w = world();
    const hub = new SessionHub(w.adapters);
    const one = w.button("one");
    const two = w.button("two");

    hub.join("default", SOCK, one.subscriber);
    hub.join("default", SOCK, two.subscriber);
    await w.settle();

    expect(one.painted.at(-1)?.stateColour).toBe("red");
    expect(two.painted.at(-1)?.stateColour).toBe("red");
  });

  it("draws the running loop's last face on a button that joins late", async () => {
    const w = world();
    const hub = new SessionHub(w.adapters);
    hub.join("default", SOCK, w.button("one").subscriber);
    await w.settle();

    const late = w.button("late");
    hub.join("default", SOCK, late.subscriber);
    // No waiting for the next poll: a key that has just appeared must not sit
    // blank for a second.
    expect(late.painted.at(-1)?.stateColour).toBe("red");
  });

  it("runs two sessions independently, each on its own socket", async () => {
    const w = world((socketPath) =>
      socketPath === SOCK ? fixture("blocked-one") : fixture("done-only"),
    );
    const hub = new SessionHub(w.adapters);
    const home = w.button("home");
    const work = w.button("work");

    hub.join("default", SOCK, home.subscriber);
    hub.join("work", OTHER, work.subscriber);
    await w.settle();

    expect(hub.loops).toBe(2);
    expect(home.painted.at(-1)?.stateColour).toBe("red");
    expect(work.painted.at(-1)?.stateColour).toBe("amber");
  });

  it("keeps polling for the buttons that are left when one goes away", async () => {
    const w = world();
    const hub = new SessionHub(w.adapters);
    const one = hub.join("default", SOCK, w.button("one").subscriber);
    const two = w.button("two");
    hub.join("default", SOCK, two.subscriber);
    await w.settle();

    one.leave();
    w.fireTimers();
    await w.settle();

    expect(hub.loops).toBe(1);
    expect(two.painted.at(-1)?.stateColour).toBe("red");
  });

  it("stops the loop when the last button leaves", async () => {
    const w = world();
    const hub = new SessionHub(w.adapters);
    const only = hub.join("default", SOCK, w.button("only").subscriber);
    await w.settle();

    only.leave();
    const before = w.calls.length;
    w.fireTimers();
    await w.settle();

    expect(hub.loops).toBe(0);
    expect(w.calls.length).toBe(before);
  });

  it("starts the cycle over when a session is left and rejoined", async () => {
    // The visited set belongs to a session, and rejoining is a fresh sitting
    // rather than the middle of the old one.
    const w = world();
    const hub = new SessionHub(w.adapters);
    const first = hub.join("default", SOCK, w.button("one").subscriber);
    await w.settle();
    first.press();
    await w.settle();
    first.leave();

    const again = hub.join("default", SOCK, w.button("one").subscriber);
    await w.settle();
    again.press();
    await w.settle();

    expect(focuses(w.calls)).toEqual(["w3:p1", "w3:p1"]);
  });

  it("repoints a button at another session, socket and cycle both", async () => {
    // What a changed `sessionName` does: leave the old session — taking its
    // loop with it, since nobody else is there — and join the new one on its
    // own socket, at the top of a fresh cycle.
    const w = world();
    const button = w.button("one");
    const hub = new SessionHub(w.adapters);

    const home = hub.join("default", SOCK, button.subscriber);
    await w.settle();
    home.press();
    await w.settle();

    home.leave();
    const work = hub.join("work", OTHER, button.subscriber);
    await w.settle();
    work.press();
    await w.settle();

    expect(hub.loops).toBe(1);
    expect(w.calls.filter((c) => c.startsWith("snapshot:")).at(-1)).toBe(`snapshot:${OTHER}`);
    // Back to the head of the order, rather than carrying the old walk over.
    expect(focuses(w.calls)).toEqual(["w3:p1", "w3:p1"]);
    // …and the nonce names the session it is raising, so the two never collide.
    expect(w.calls.filter((c) => c.startsWith("raise:"))).toEqual([
      "raise:one:sd-herdr raise default #1",
      "raise:one:sd-herdr raise work #1",
    ]);
  });

  it("shares the cycle between two buttons on one session, as the session owns it", async () => {
    const w = world();
    const hub = new SessionHub(w.adapters);
    const one = hub.join("default", SOCK, w.button("one").subscriber);
    const two = hub.join("default", SOCK, w.button("two").subscriber);
    await w.settle();

    one.press();
    await w.settle();
    two.press();
    await w.settle();

    expect(focuses(w.calls)).toEqual(["w3:p1", "w0:p1"]);
  });

  it("hands each raise back to the button whose press asked for it", async () => {
    const w = world();
    const hub = new SessionHub(w.adapters);
    const one = hub.join("default", SOCK, w.button("one").subscriber);
    const two = hub.join("default", SOCK, w.button("two").subscriber);
    await w.settle();

    one.press();
    await w.settle();
    two.press();
    await w.settle();

    expect(w.calls.filter((c) => c.startsWith("raise:"))).toEqual([
      "raise:one:sd-herdr raise default #1",
      "raise:two:sd-herdr raise default #2",
    ]);
  });

  it("does not hand a departed button's raise to the one that is left", async () => {
    // The press is four adapter calls and a button can go away between them.
    // Its raise belongs to no key any more, so the button still there answers
    // it — but its own next press must not then be answered by the ghost.
    let landFocus = () => {};
    const w = world();
    const held: SharedAdapters = {
      ...w.adapters,
      focusPane: (socketPath, paneId) =>
        w.adapters.focusPane(socketPath, paneId).then(
          () =>
            new Promise<void>((resolve) => {
              landFocus = resolve;
            }),
        ),
    };
    const hub = new SessionHub(held);
    const leaving = hub.join("default", SOCK, w.button("leaving").subscriber);
    hub.join("default", SOCK, w.button("staying").subscriber);
    await w.settle();

    leaving.press();
    await w.settle();
    leaving.leave();
    landFocus();
    await w.settle();

    expect(w.calls.filter((c) => c.startsWith("raise:"))).toEqual([
      "raise:staying:sd-herdr raise default #1",
    ]);
  });
});
