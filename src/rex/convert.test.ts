import { describe, expect, it } from "vitest";

import { attentionSet } from "../core/attention.js";
import { bodyFor, paneIndex } from "../core/body.js";
import { isRestart, lifetimeOf } from "../core/lifetime.js";
import { rexFixture, rexWire } from "../testing/rex-fixtures.js";
import { defaultWindowLabel, fromRex } from "./convert.js";

const agentOf = (name: Parameters<typeof rexFixture>[0], blockId: string) =>
  rexFixture(name).agents.find((a) => a.paneId === `block:${blockId}`);

const labelOf = (name: Parameters<typeof rexFixture>[0], windowId: string) =>
  rexFixture(name).groups?.find((g) => g.groupId === `window:${windowId}`)?.label;

describe("fromRex: agents", () => {
  it("maps block_id to the pane and window_id to both the tab and the group", () => {
    expect(agentOf("two-windows", "a1")).toEqual({
      paneId: "block:a1",
      tabId: "window:two-aaaaaaa1",
      groupId: "window:two-aaaaaaa1",
      status: "blocked",
      waitKey: Date.parse("2026-11-06T08:00:00+01:00"),
    });
  });

  it("makes a block an agent only if some record has an effective_app", () => {
    // n5 reports, but with no app anywhere in its chain; n6 reports nothing.
    expect(rexFixture("nested-records").agents.map((a) => a.paneId)).toEqual([
      "block:n1",
      "block:n2",
      "block:n3",
      "block:n4",
    ]);
  });

  it("counts a child record that inherits its effective_app from a parent", () => {
    // n1's child carries `effective_app` and no `app`; the root is `idle`.
    const view = rexWire("nested-records");
    const child = view.reports.get("block:n1")?.records.find((r) => r.id === "build/test");
    expect(child?.effective_app).toBe("claude-code");
    expect(child?.app).toBeUndefined();
    expect(agentOf("nested-records", "n1")).toBeDefined();
  });

  it("takes the most urgent record of a nest, and its updated_at", () => {
    // Root idle, child blocked: blocked wins, at the child's time.
    expect(agentOf("nested-records", "n1")).toMatchObject({
      status: "blocked",
      waitKey: Date.parse("2026-11-06T08:05:00+01:00"),
    });
    // working and done: done is the more urgent tier, at its own time.
    expect(agentOf("nested-records", "n4")).toMatchObject({
      status: "done",
      waitKey: Date.parse("2026-11-06T08:21:00+01:00"),
    });
  });

  it("reads error as blocked", () => {
    expect(agentOf("nested-records", "n2")).toMatchObject({
      status: "blocked",
      waitKey: Date.parse("2026-11-06T08:10:00+01:00"),
    });
  });

  it("reads a state it does not know as idle", () => {
    expect(agentOf("nested-records", "n3")?.status).toBe("idle");
  });

  it("gathers agents from every layer, floating ones included", () => {
    expect(rexFixture("floating-layer").agents.map((a) => a.paneId)).toEqual([
      "block:d1",
      "block:d3",
    ]);
  });

  it("reads the captured session", () => {
    const snapshot = rexFixture("live-session");
    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0]).toMatchObject({ status: "done" });
  });

  it("skips a block that is in the view but has no report, as a non-terminal block", () => {
    const { view } = rexWire("two-windows");
    expect(fromRex([view], new Map(), "i").agents).toEqual([]);
  });

  it("survives a view with no windows", () => {
    expect(fromRex([{}], new Map(), "i")).toEqual({
      agents: [],
      groups: [],
      layouts: [],
      lifetime: new Map([["instance", "i"]]),
    });
  });
});

describe("fromRex: the body label rule", () => {
  it("computes the default label from the last eight characters of the id", () => {
    expect(defaultWindowLabel("window:01a1b1e2-0154-773f-bb75-379551e6587e")).toBe(
      "Window 51e6587e",
    );
  });

  it("names a named window by its label", () => {
    expect(labelOf("two-windows", "two-aaaaaaa1")).toBe("api");
  });

  it("names an unnamed window by its session's label, not its agent's title", () => {
    expect(labelOf("two-windows", "two-bbbbbbb2")).toBe("work");
    expect(labelOf("live-session", "01a1b1e2-0154-773f-bb75-379551e6587e")).toBe("nix");
  });

  it("compares against the window's own default, not the shape of one", () => {
    // A window someone named `Window bbbbbbb2` is named, because that is not
    // *its* default: only the string computed from its own id is.
    const { view, reports } = rexWire("two-windows");
    const renamed = {
      ...view,
      windows: view.windows?.map((w) =>
        w.window_id === "window:two-aaaaaaa1" ? { ...w, label: "Window bbbbbbb2" } : w,
      ),
    };
    const groups = fromRex([renamed], reports, "i").groups;
    expect(groups?.find((g) => g.groupId === "window:two-aaaaaaa1")?.label).toBe("Window bbbbbbb2");
  });

  it("keeps the default label when the session has no label either", () => {
    const { view, reports } = rexWire("two-windows");
    const groups = fromRex([{ ...view, label: "" }], reports, "i").groups;
    expect(groups?.find((g) => g.groupId === "window:two-bbbbbbb2")?.label).toBe("Window bbbbbbb2");
  });
});

describe("fromRex: the pane index", () => {
  const index = (name: Parameters<typeof rexFixture>[0], tab: string, block: string) =>
    paneIndex(rexFixture(name), `window:${tab}`, `block:${block}`);

  it("sorts a split tab's leaves by (y, x) whatever order the blocks are listed in", () => {
    // The tree is left | (c2 over c3), and `blocks` lists c3 first.
    expect(index("split-tab", "split-ccccccc1", "c1")).toBe(1);
    expect(index("split-tab", "split-ccccccc1", "c2")).toBe(2);
    expect(index("split-tab", "split-ccccccc1", "c3")).toBe(3);
  });

  it("counts a shell beside the agent", () => {
    expect(index("two-windows", "two-aaaaaaa1", "a2")).toBe(2);
  });

  it("excludes floating layers from the count and the agents on them from the index", () => {
    const snapshot = rexFixture("floating-layer");
    expect(snapshot.layouts?.find((l) => l.tabId === "window:float-ddddddd1")?.panes).toEqual([
      { paneId: "block:d1", x: 0, y: 0 },
      { paneId: "block:d2", x: 0.5, y: 0 },
    ]);
    expect(index("floating-layer", "float-ddddddd1", "d2")).toBe(2);
    expect(index("floating-layer", "float-ddddddd1", "d3")).toBeNull();
  });

  it("indexes a body when an attention sibling shares the tab", () => {
    const snapshot = rexFixture("split-tab");
    const set = attentionSet(snapshot.agents);
    expect(bodyFor(snapshot, set, "block:c3")).toBe("review ③");
    expect(bodyFor(snapshot, set, "block:c1")).toBe("review ①");
  });

  it("names a floating agent by its window without an index", () => {
    const snapshot = rexFixture("floating-layer");
    expect(bodyFor(snapshot, attentionSet(snapshot.agents), "block:d3")).toBe("scratch");
  });
});

describe("fromRex: a whole server", () => {
  it("lays every session's windows side by side and ranks their agents together", () => {
    const one = rexWire("two-windows");
    const two = rexWire("floating-layer");
    const snapshot = fromRex([one.view, two.view], new Map([...one.reports, ...two.reports]), "i");
    const windows = (name: Parameters<typeof rexWire>[0]) =>
      (rexWire(name).view.windows ?? []).map((w) => w.window_id);
    expect(snapshot.groups?.map((g) => g.groupId)).toEqual([
      ...windows("two-windows"),
      ...windows("floating-layer"),
    ]);
    expect(snapshot.agents).toEqual([
      ...rexFixture("two-windows").agents,
      ...rexFixture("floating-layer").agents,
    ]);
  });
});

describe("fromRex: the lifetime marker", () => {
  const { view, reports } = rexWire("two-windows");
  const marker = (id: string) => lifetimeOf(fromRex([view], reports, id));

  it("carries the instance_id under one key, and a changed one reads as a restart", () => {
    expect([...marker("A")]).toEqual([["instance", "A"]]);
    expect(isRestart(marker("A"), marker("B"))).toBe(true);
  });

  it("reads an unchanged one as no restart", () => {
    expect(isRestart(marker("A"), marker("A"))).toBe(false);
  });
});
