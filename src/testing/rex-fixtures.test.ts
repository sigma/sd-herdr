import { describe, expect, it } from "vitest";

import { REX_FIXTURE_NAMES, rexFixture, rexProvenance, rexWire } from "./rex-fixtures.js";

/** The Rex corpus's own gate: provenance that cannot rot, as for herdr's. */
describe("the Rex fixture corpus", () => {
  it.each(REX_FIXTURE_NAMES)("%s declares its provenance", (name) => {
    const p = rexProvenance(name);
    expect(p.kind).toMatch(/^(captured|derived)$/);
    expect(p.note.length).toBeGreaterThan(0);
  });

  it.each(REX_FIXTURE_NAMES)("%s says what it was derived from, if derived", (name) => {
    const p = rexProvenance(name);
    if (p.kind !== "derived") return;
    expect(p.derivedFrom).toBeTruthy();
    expect(p.note).toContain("HAND-DERIVED");
  });

  it.each(REX_FIXTURE_NAMES)("%s dates and attributes itself, if captured", (name) => {
    const p = rexProvenance(name);
    if (p.kind !== "captured") return;
    expect(p.capturedAt).toBeTruthy();
    expect(p.subject).toBeTruthy();
    expect(p.method).toBeTruthy();
  });

  it.each(REX_FIXTURE_NAMES)("%s reports only blocks the view holds", (name) => {
    const { view, reports } = rexWire(name);
    const ids = new Set(
      (view.windows ?? [])
        .flatMap((w) => (w.layers ?? []).flatMap((l) => l.blocks ?? []))
        .map((b) => b.block_id),
    );
    for (const id of reports.keys()) expect(ids.has(id)).toBe(true);
  });

  it("holds one fixture that actually came off a server", () => {
    const captured = REX_FIXTURE_NAMES.filter((n) => rexProvenance(n).kind === "captured");
    expect(captured).toEqual(["live-session"]);
    expect(rexFixture("live-session").agents.length).toBeGreaterThan(0);
  });
});
