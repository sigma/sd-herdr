import { describe, expect, it } from "vitest";

import { FIXTURE_NAMES, fixture, provenance } from "./fixtures.js";

/**
 * The corpus's own gate. Provenance is only worth having if it cannot rot, so
 * "every fixture says where it came from" is a test rather than a convention in
 * a README.
 */
describe("the fixture corpus", () => {
  it.each(FIXTURE_NAMES)("%s declares its provenance", (name) => {
    const p = provenance(name);
    expect(p.kind).toMatch(/^(captured|derived)$/);
    expect(p.note.length).toBeGreaterThan(0);
  });

  it.each(FIXTURE_NAMES)("%s says what it was derived from, if derived", (name) => {
    const p = provenance(name);
    if (p.kind !== "derived") return;
    expect(p.derivedFrom).toBeTruthy();
    // A derived fixture must announce itself in the note, not just in a field a
    // reader can skip: it is a statement of intent, not evidence.
    expect(p.note).toContain("HAND-DERIVED");
  });

  it.each(FIXTURE_NAMES)("%s dates and attributes itself, if captured", (name) => {
    const p = provenance(name);
    if (p.kind !== "captured") return;
    expect(p.capturedAt).toBeTruthy();
    expect(p.subject).toBeTruthy();
    expect(p.method).toBeTruthy();
  });

  it.each(FIXTURE_NAMES)("%s holds a snapshot the plugin can read", (name) => {
    const snapshot = fixture(name);
    expect(snapshot.protocol).toBe(19);
    expect(Array.isArray(snapshot.agents)).toBe(true);
    for (const agent of snapshot.agents) {
      expect(agent.pane_id).toBeTruthy();
      expect(agent.tab_id).toBeTruthy();
      expect(agent.workspace_id).toBeTruthy();
      expect(typeof agent.state_change_seq).toBe("number");
    }
  });

  it("holds one snapshot that actually came off a socket", () => {
    const captured = FIXTURE_NAMES.filter((n) => provenance(n).kind === "captured");
    expect(captured).toEqual(["live-session"]);
    expect(fixture("live-session").agents.length).toBeGreaterThan(0);
  });
});
