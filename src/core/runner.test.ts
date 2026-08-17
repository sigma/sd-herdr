import { describe, expect, it } from "vitest";

import type { FaceDescriptor } from "../face/descriptor.js";
import type { Snapshot } from "../herdr/snapshot.js";
import { fixture } from "../testing/fixtures.js";
import { type Adapters, Runner } from "./runner.js";

/**
 * A world under the test's control. Time advances because the test says so and
 * timers fire because the test fires them — nothing here sleeps, so a one-second
 * poll cadence costs no wall clock to assert.
 */
const SOCK = "/Users/dev/.config/herdr/herdr.sock";

function world(overrides: Partial<Adapters> = {}) {
  const painted: FaceDescriptor[] = [];
  const calls: string[] = [];
  let timers: { ms: number; fn: () => void }[] = [];
  let clock = 1000;

  const adapters: Adapters = {
    async snapshot(socketPath): Promise<Snapshot> {
      calls.push(`snapshot:${socketPath}`);
      return fixture("blocked-one");
    },
    paint(descriptor) {
      painted.push(descriptor);
    },
    now: () => clock,
    schedule(ms, fn) {
      const timer = { ms, fn };
      timers.push(timer);
      return {
        cancel() {
          timers = timers.filter((t) => t !== timer);
        },
      };
    },
    ...overrides,
  };

  return {
    adapters,
    painted,
    calls,
    /** Let every scheduled callback run, as if its delay had elapsed. */
    fireTimers() {
      const due = timers;
      timers = [];
      clock += 1000;
      for (const t of due) t.fn();
    },
    pendingDelays: () => timers.map((t) => t.ms),
    /** Let the microtask queue drain, so adapter promises settle. */
    settle: () => new Promise((r) => setImmediate(r)),
  };
}

describe("Runner", () => {
  it("snapshots and paints red when the button appears", async () => {
    const w = world();
    const runner = new Runner("default", SOCK, w.adapters);

    runner.appeared();
    await w.settle();

    expect(w.calls).toEqual([`snapshot:${SOCK}`]);
    expect(w.painted.at(-1)?.stateColour).toBe("red");
  });

  it("shows grey before the first snapshot lands, never a clear face", async () => {
    const w = world();
    new Runner("default", SOCK, w.adapters).appeared();
    expect(w.painted[0]?.stateColour).toBe("grey");
  });

  it("schedules the next poll only after the snapshot completes", async () => {
    const w = world();
    const runner = new Runner("default", SOCK, w.adapters);

    runner.appeared();
    // Only the heartbeat is queued while a request is in flight — no second
    // poll is scheduled behind the first.
    expect(w.pendingDelays()).toEqual([500]);
    await w.settle();
    expect(w.pendingDelays()).toEqual([500, 1000]);
  });

  it("keeps polling the same socket", async () => {
    const w = world();
    const runner = new Runner("default", SOCK, w.adapters);

    runner.appeared();
    await w.settle();
    w.fireTimers();
    await w.settle();

    expect(w.calls).toEqual([`snapshot:${SOCK}`, `snapshot:${SOCK}`]);
  });

  it("stops dead when the button disappears", async () => {
    const w = world();
    const runner = new Runner("default", SOCK, w.adapters);

    runner.appeared();
    await w.settle();
    runner.disappeared();
    w.fireTimers();
    await w.settle();

    // The heartbeat stops with the poll: an invisible button costs nothing at all.
    expect(w.pendingDelays()).toEqual([]);
    expect(w.calls).toEqual([`snapshot:${SOCK}`]);
  });

  it("redraws only when the face changes, not once per poll", async () => {
    const w = world();
    const runner = new Runner("default", SOCK, w.adapters);

    runner.appeared();
    await w.settle();
    w.fireTimers();
    await w.settle();
    w.fireTimers();
    await w.settle();

    // grey, then red, and nothing more: three snapshots, two paints.
    expect(w.painted.map((f) => f.stateColour)).toEqual(["grey", "red"]);
  });

  it("holds its face and keeps polling when a snapshot throws", async () => {
    let fail = false;
    const attempts: string[] = [];
    const w = world({
      async snapshot(socketPath) {
        attempts.push(socketPath);
        if (fail) throw new Error("ECONNREFUSED");
        return fixture("blocked-one");
      },
    });
    const runner = new Runner("default", SOCK, w.adapters);

    runner.appeared();
    await w.settle();
    fail = true;
    w.fireTimers();
    await w.settle();

    // A dropped poll does not repaint: the last good face stands until a
    // staleness deadline retires it, which is #21's.
    expect(w.painted.at(-1)?.stateColour).toBe("red");
    w.fireTimers();
    await w.settle();
    // Three attempts, all on the same path: a failure is not a reason to go
    // looking for a different socket.
    expect(attempts).toEqual([SOCK, SOCK, SOCK]);
  });

  it("stays grey and keeps trying when nothing is listening on the socket", async () => {
    // What a stopped session looks like from here: the path is fine, the
    // connection is not. ENOENT and ECONNREFUSED arrive as the same rejection.
    const w = world({
      snapshot: async () => {
        throw Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
      },
    });
    const runner = new Runner("default", SOCK, w.adapters);

    runner.appeared();
    await w.settle();

    expect(w.painted.at(-1)?.stateColour).toBe("grey");
    expect(w.pendingDelays()).toEqual([500, 1000]);
  });

  it("goes grey when a poll wedges and never comes back", async () => {
    // The hardest failure to see: no rejection to count, no answer to render.
    // Only the heartbeat still moves, and the staleness deadline rides on it.
    let wedge = false;
    const attempts: string[] = [];
    const w = world({
      snapshot: async (socketPath) => {
        attempts.push(socketPath);
        return wedge ? new Promise<Snapshot>(() => {}) : fixture("blocked-one");
      },
    });
    const runner = new Runner("default", SOCK, w.adapters);

    runner.appeared();
    await w.settle();
    expect(w.painted.at(-1)?.stateColour).toBe("red");

    wedge = true;
    for (let i = 0; i < 5; i += 1) {
      w.fireTimers();
      await w.settle();
    }

    expect(w.painted.at(-1)?.stateColour).toBe("grey");
    // …and the request really is still hanging: nothing rescheduled behind it.
    expect(attempts).toEqual([SOCK, SOCK]);
  });

  it("backs off while the socket stays unreachable, and picks straight back up", async () => {
    let fail = true;
    const w = world({
      async snapshot() {
        if (fail) throw new Error("ECONNREFUSED");
        return fixture("blocked-one");
      },
    });
    const runner = new Runner("default", SOCK, w.adapters);
    const polls: number[] = [];

    runner.appeared();
    await w.settle();
    for (let i = 0; i < 4; i += 1) {
      polls.push(...w.pendingDelays().filter((ms) => ms !== 500));
      w.fireTimers();
      await w.settle();
    }
    expect(polls).toEqual([1000, 2000, 4000, 5000]);

    fail = false;
    w.fireTimers();
    await w.settle();

    expect(w.painted.at(-1)?.stateColour).toBe("red");
    expect(w.pendingDelays().filter((ms) => ms !== 500)).toEqual([1000]);
  });
});
