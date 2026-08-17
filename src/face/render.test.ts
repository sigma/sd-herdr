import { describe, expect, it } from "vitest";

import type { FaceDescriptor } from "./descriptor.js";
import { clip, fitSize, renderFaceSvg, svgToImageUri } from "./render.js";

const face = (over: Partial<FaceDescriptor> = {}): FaceDescriptor => ({
  stateColour: "red",
  nameplate: "herdr",
  body: "trunk",
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
