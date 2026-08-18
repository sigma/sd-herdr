import { describe, expect, it } from "vitest";

import type { FaceDescriptor } from "./descriptor.js";
import { clip, fitSize, renderFaceSvg, svgToImageUri } from "./render.js";

const face = (over: Partial<FaceDescriptor> = {}): FaceDescriptor => ({
  stateColour: "red",
  nameplate: "herdr",
  body: "trunk",
  pips: [],
  pipOverflow: false,
  ...over,
});

describe("renderFaceSvg", () => {
  it("draws a complete 72x72 document", () => {
    const svg = renderFaceSvg(face());
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('width="72" height="72"');
  });

  it("colours the nameplate per state colour", () => {
    expect(renderFaceSvg(face({ stateColour: "red" }))).toContain("#C62828");
    expect(renderFaceSvg(face({ stateColour: "green" }))).toContain("#2E7D32");
    expect(renderFaceSvg(face({ stateColour: "amber" }))).toContain("#E8A317");
    expect(renderFaceSvg(face({ stateColour: "grey" }))).toContain("#33363D");
    expect(renderFaceSvg(face({ stateColour: "dark" }))).toContain("#23262C");
  });

  it("carries the nameplate text and the body line", () => {
    const svg = renderFaceSvg(face({ nameplate: "work", body: "playpen" }));
    expect(svg).toContain(">work</text>");
    expect(svg).toContain(">playpen</text>");
  });

  it("clips a long nameplate but never the body", () => {
    const svg = renderFaceSvg(face({ nameplate: "a-very-long-session", body: "infrastructure ②" }));
    expect(svg).toContain(">a-very-long-…</text>");
    expect(svg).toContain(">infrastructure ②</text>");
  });

  it("draws one tier-coloured pip per other waiter", () => {
    const svg = renderFaceSvg(face({ pips: ["red", "amber", "grey"] }));
    expect(svg.match(/<circle /g)).toHaveLength(3);
    expect(svg).toContain('fill="#C62828"');
    expect(svg).toContain('fill="#E8A317"');
    // The grey pip is drawn in the plate's ink rather than its fill: a 4px dot
    // in `#33363D` vanishes against the tile's ground.
    expect(svg).toContain('fill="#767B85"');
    expect(svg).not.toContain('<circle cx="36" cy="59" r="4" fill="#33363D"/>');
  });

  it("sits the nameplate text below the strip's centre, where it reads level", () => {
    // The plate is 13px tall; its geometric centre reads high on the device.
    expect(renderFaceSvg(face({ nameplate: "work" }))).toContain('y="10"');
  });

  it("brightens the green pip, which the plate's green would lose to the ground", () => {
    const svg = renderFaceSvg(face({ pips: ["green"] }));
    expect(svg).toContain('fill="#43A047"');
    expect(svg).not.toContain('<circle cx="36" cy="59" r="4" fill="#2E7D32"/>');
  });

  it("draws no pip row when the named target is the only thing waiting", () => {
    expect(renderFaceSvg(face())).not.toContain("<circle");
  });

  it("says … rather than counting past the cap", () => {
    const svg = renderFaceSvg(face({ pips: ["red", "red", "red", "red"], pipOverflow: true }));
    expect(svg.match(/<circle /g)).toHaveLength(4);
    expect(svg).toContain(">…</text>");
  });

  it("uses only fill for pips, leaving the hollow-vs-filled axis unused", () => {
    // A ring would warn about a cost the user cannot avoid, so nothing here
    // strokes a pip — the axis is kept free on purpose.
    const svg = renderFaceSvg(face({ pips: ["red", "amber"] }));
    expect(svg).not.toContain("stroke");
  });

  it("lifts the body when a pip row shares the tile with it", () => {
    expect(renderFaceSvg(face({ pips: ["red"] }))).toContain('y="38"');
    expect(renderFaceSvg(face())).toContain('y="44"');
  });

  it("escapes markup in text so a session name cannot break the document", () => {
    const svg = renderFaceSvg(face({ nameplate: "a&b", body: "<x>" }));
    expect(svg).toContain(">a&amp;b</text>");
    expect(svg).toContain(">&lt;x&gt;</text>");
  });
});

describe("clip", () => {
  it("leaves a name that fits alone", () => {
    expect(clip("trunk", 8)).toBe("trunk");
  });

  it("clips a long name to a readable prefix rather than shrinking it", () => {
    expect(clip("infrastructure", 8)).toBe("infrast…");
  });
});

describe("fitSize", () => {
  it("caps a short label at the type-size ceiling", () => {
    expect(fitSize("api")).toBe(22);
  });

  it("shrinks a longer label rather than dropping its tail", () => {
    expect(fitSize("infrastructure")).toBeLessThan(fitSize("trunk"));
    expect(fitSize("infrastructure")).toBeGreaterThan(0);
  });
});

describe("svgToImageUri", () => {
  it("wraps the document as a base64 data URI", () => {
    const uri = svgToImageUri("<svg/>");
    expect(uri).toBe(`data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`);
  });
});
