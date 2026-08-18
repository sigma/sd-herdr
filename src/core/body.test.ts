import { describe, expect, it } from "vitest";

import type { Snapshot } from "../herdr/snapshot.js";
import { fixture } from "../testing/fixtures.js";
import { attentionSet } from "./attention.js";
import { bodyFor, paneIndex } from "./body.js";

/** The body a given pane would get, from the snapshot it was seen in. */
const bodyOf = (name: Parameters<typeof fixture>[0], paneId: string): string => {
  const snapshot = fixture(name);
  return bodyFor(snapshot, attentionSet(snapshot.agents), paneId);
};

describe("bodyFor", () => {
  it("names the target's workspace, and nothing else, when it is alone in its tab", () => {
    // The common case, and the one the tile is glanced at for.
    expect(bodyOf("blocked-one", "w0:p1")).toBe("nix");
    expect(bodyOf("mixed-tiers", "w3:p1")).toBe("playpen");
  });

  it("adds a pane index when another attention pane shares the tab", () => {
    // Two blocked agents in w0:t1 — a workspace label alone stops saying which
    // one the press reaches.
    expect(bodyOf("split-tab", "w0:p2")).toBe("trunk ①");
    expect(bodyOf("split-tab", "w0:p7")).toBe("trunk ③");
  });

  it("counts every pane in the tab, shell included, so the number matches the screen", () => {
    // split-tab is agent | shell | agent: the second agent is pane ③, not ②.
    expect(bodyOf("split-tab", "w0:p7")).toContain("③");
  });

  it("leaves the label bare when the tab's other pane is a plain shell", () => {
    // A shell is not an attention sibling: the press can still only go to the
    // one agent, so the label is unambiguous and pays for nothing.
    expect(bodyOf("split-tab", "w1:p1")).toBe("nix");
  });

  it("takes the index from geometry, never from the pane id", () => {
    // split-tab lists its panes out of geometric order and its ids are neither
    // contiguous nor ordered: p2 is leftmost and so first, p7 is rightmost and
    // so third.
    expect(bodyOf("split-tab", "w0:p2")).toBe("trunk ①");
  });

  it("is empty for a pane that is not in the attention set", () => {
    expect(bodyOf("blocked-one", "w1:p1")).toBe("");
    expect(bodyOf("blocked-one", "nonesuch")).toBe("");
  });

  it("falls back to the workspace id when the snapshot carries no labels", () => {
    const bare: Snapshot = { ...fixture("blocked-one"), workspaces: undefined };
    expect(bodyFor(bare, attentionSet(bare.agents), "w0:p1")).toBe("w0");
  });

  it("leaves the label bare when a sibling exists but the layout does not", () => {
    // No geometry, no index — and an index guessed from anything else would be
    // a number the user cannot check against the screen.
    const flat: Snapshot = { ...fixture("split-tab"), layouts: undefined };
    expect(bodyFor(flat, attentionSet(flat.agents), "w0:p2")).toBe("trunk");
  });
});

describe("paneIndex", () => {
  it("is 1-based over the tab's panes sorted by (y, x)", () => {
    const snapshot = fixture("split-tab");
    expect(paneIndex(snapshot, "w0:t1", "w0:p2")).toBe(1);
    expect(paneIndex(snapshot, "w0:t1", "w0:p5")).toBe(2);
    expect(paneIndex(snapshot, "w0:t1", "w0:p7")).toBe(3);
  });

  it("sorts rows before columns, so a stacked split reads top to bottom", () => {
    const stacked: Snapshot = {
      ...fixture("split-tab"),
      layouts: [
        {
          tab_id: "t",
          panes: [
            { pane_id: "bottom", rect: { x: 0, y: 80 } },
            { pane_id: "top-right", rect: { x: 40, y: 0 } },
            { pane_id: "top-left", rect: { x: 0, y: 0 } },
          ],
        },
      ],
    };
    expect(paneIndex(stacked, "t", "top-left")).toBe(1);
    expect(paneIndex(stacked, "t", "top-right")).toBe(2);
    expect(paneIndex(stacked, "t", "bottom")).toBe(3);
  });

  it("is null when the tab has no layout, or the pane is not in it", () => {
    const snapshot = fixture("split-tab");
    expect(paneIndex(snapshot, "w9:t1", "w0:p2")).toBeNull();
    expect(paneIndex(snapshot, "w0:t1", "nonesuch")).toBeNull();
  });
});
