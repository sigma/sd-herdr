/**
 * Descriptor → SVG. The whole renderer: a pure `FaceDescriptor -> string`, so it
 * is testable by asserting on markup and holds no decisions of its own.
 *
 * The structure is variant E from `prototypes/button-face.html` — a
 * state-coloured nameplate carrying the session name, and a body line naming
 * where the next press goes. The pip row for the other waiters is not here yet:
 * nothing computes an attention set, so there is nothing to draw pips for.
 */

import type { FaceDescriptor, StateColour } from "./descriptor.js";

/** Stream Deck keys are 72×72; the prototype authored at that size, so we do too. */
const SIZE = 72;

/** The nameplate strip's height, in key pixels. */
const NAMEPLATE_HEIGHT = 13;

/** The tile's ground, behind everything. */
const GROUND = "#101216";

const FONT = "ui-sans-serif, -apple-system, Helvetica, Arial, sans-serif";

/**
 * One row per state colour: the nameplate's fill, the ink on it, and the ink the
 * body is drawn in. One table rather than one per element, so a state's whole
 * palette reads in a single line — and so adding the pip row does not add a
 * fourth table keyed on the same type.
 */
const PALETTE: Record<StateColour, { plate: string; plateInk: string; bodyInk: string }> = {
  // Amber flips the plate ink dark, the only pairing where white loses contrast.
  red: { plate: "#C62828", plateInk: "rgba(255,255,255,.92)", bodyInk: "#FFFFFF" },
  amber: { plate: "#E8A317", plateInk: "#2A1E00", bodyInk: "#FFFFFF" },
  // Nothing waiting and nothing visible both dim the body — there is no target.
  dark: { plate: "#23262C", plateInk: "#666C78", bodyInk: "#767B85" },
  grey: { plate: "#33363D", plateInk: "#9AA0AA", bodyInk: "#767B85" },
};

/** Nameplate glyphs are 9px; this many fit across the 72px strip with margins. */
const NAMEPLATE_MAX_CHARS = 13;

/** The body's type size ceiling, and the width it is fitted into. */
const BODY_MAX_SIZE = 22;
const BODY_BOX = 62;

function escapeXml(s: string): string {
  return s.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] as string,
  );
}

/**
 * Clip the nameplate to a readable prefix rather than shrinking it to fit. A
 * name shrunk to ~5px is unreadable and so fails the tile's only job, while a
 * legible prefix is enough to tell two sessions apart.
 */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The body does the opposite: it *shrinks* to fit its box. A workspace label
 * clipped would drop the pane index off its tail — and the index is the one
 * thing on the line that disambiguates. Crude but adequate width fit, lifted
 * from the prototype.
 */
export function fitSize(text: string, box = BODY_BOX, max = BODY_MAX_SIZE): number {
  if (text.length === 0) return max;
  return Math.min(max, Math.floor(box / (text.length * 0.58)));
}

function textNode(content: string, x: number, y: number, size: number, fill: string): string {
  return (
    `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="700"` +
    ` text-anchor="middle" dominant-baseline="central" font-family="${FONT}">` +
    `${escapeXml(content)}</text>`
  );
}

/** Render a face as a complete 72×72 SVG document, ready for `setImage`. */
export function renderFaceSvg(face: FaceDescriptor): string {
  const palette = PALETTE[face.stateColour];
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"` +
    ` viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<rect width="${SIZE}" height="${SIZE}" fill="${GROUND}"/>` +
    `<rect width="${SIZE}" height="${NAMEPLATE_HEIGHT}" fill="${palette.plate}"/>` +
    textNode(clip(face.nameplate, NAMEPLATE_MAX_CHARS), SIZE / 2, 7, 9, palette.plateInk) +
    textNode(face.body, SIZE / 2, 44, fitSize(face.body), palette.bodyInk) +
    `</svg>`
  );
}

/**
 * Wrap an SVG document as a base64 `data:` URI for `KeyAction.setImage`. The SDK
 * types accept a bare `<svg>` string, but the Stream Deck app treats one as a
 * file path and silently ignores it; the base64 form is what every app build
 * honors.
 */
export function svgToImageUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
