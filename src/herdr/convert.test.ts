import { describe, expect, it } from "vitest";

import { fixture, wireFixture } from "../testing/fixtures.js";
import { fromHerdr } from "./convert.js";

describe("fromHerdr", () => {
  it("maps an agent's ids, status and state_change_seq, with workspace as the group", () => {
    const wire = wireFixture("blocked-one");
    const agent = wire.agents[0];
    const [first] = fromHerdr(wire).agents;
    expect(first).toEqual({
      paneId: agent?.pane_id,
      tabId: agent?.tab_id,
      groupId: agent?.workspace_id,
      status: agent?.agent_status,
      waitKey: agent?.state_change_seq,
    });
    expect(first).toMatchObject({ paneId: "w0:p1", groupId: "w0", status: "blocked" });
  });

  it("keeps every agent, in order", () => {
    const wire = wireFixture("mixed-tiers");
    expect(fromHerdr(wire).agents.map((a) => a.paneId)).toEqual(wire.agents.map((a) => a.pane_id));
  });

  it("drops an unknown agent that carries no agent kind, which is just a shell", () => {
    const wire = wireFixture("unknown-only");
    expect(wire.agents).toHaveLength(2);
    expect(fromHerdr(wire).agents.map((a) => a.status)).toEqual(["unknown"]);
  });

  it("maps workspace labels to group labels", () => {
    expect(fixture("blocked-one").groups).toEqual([
      { groupId: "w0", label: "nix" },
      { groupId: "w1", label: "trunk" },
    ]);
  });

  it("flattens each layout pane's rect to its origin", () => {
    const wire = wireFixture("split-tab");
    const wired = wire.layouts?.find((l) => l.tab_id === "w0:t1");
    const layout = fromHerdr(wire).layouts?.find((l) => l.tabId === "w0:t1");
    expect(layout?.panes).toEqual(
      wired?.panes.map((p) => ({ paneId: p.pane_id, x: p.rect.x, y: p.rect.y })),
    );
    expect(layout?.panes).toHaveLength(3);
  });

  it("carries the pane_id to terminal_id map as the lifetime marker", () => {
    expect([...(fixture("blocked-one").lifetime ?? [])]).toEqual([
      ["w0:p1", "term_aaa0000000001"],
      ["w1:p1", "term_aaa0000000002"],
    ]);
  });

  it("builds the marker from panes, so it survives an empty agent list", () => {
    const restarted = fromHerdr(wireFixture("restart-empty"));
    expect(restarted.agents).toEqual([]);
    expect(restarted.lifetime?.size).toBe(2);
  });

  it("leaves optional collections absent when the wire snapshot has none", () => {
    const bare = fromHerdr({
      ...wireFixture("blocked-one"),
      workspaces: undefined,
      panes: undefined,
      layouts: undefined,
    });
    expect(bare.groups).toBeUndefined();
    expect(bare.layouts).toBeUndefined();
    expect(bare.lifetime).toBeUndefined();
  });
});
