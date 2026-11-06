/**
 * Descriptor → SVG. The whole renderer: a pure `FaceDescriptor -> string`, so it
 * is testable by asserting on markup and holds no decisions of its own.
 *
 * The structure is variant E from `prototypes/button-face.html` — a
 * state-coloured nameplate carrying the session name, a body line naming where
 * the next press goes, and a row of tier-coloured pips for the other waiters.
 */

import type { FaceDescriptor, PipColour, StateColour } from "./descriptor.js";

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
  green: { plate: "#2E7D32", plateInk: "rgba(255,255,255,.92)", bodyInk: "#FFFFFF" },
  amber: { plate: "#E8A317", plateInk: "#2A1E00", bodyInk: "#FFFFFF" },
  // Nothing waiting and nothing visible both dim the body — there is no target.
  dark: { plate: "#23262C", plateInk: "#666C78", bodyInk: "#767B85" },
  grey: { plate: "#33363D", plateInk: "#9AA0AA", bodyInk: "#767B85" },
};

/**
 * A pip's fill, per tier. The same three colours the nameplate uses for the
 * same three tiers — one agent's `unknown` is the same grey as a session the
 * plugin cannot read, because it is the same statement about one pane.
 */
const PIP_FILL: Record<PipColour, string> = {
  red: "#C62828",
  // A shade up from the plate's green: the same reason the grey pip differs,
  // one step milder — `#2E7D32` reads nearly black at 4px on this ground.
  green: "#43A047",
  amber: "#E8A317",
  // The grey face's body ink, not the plate's fill. A pip is a small dot on the
  // tile's near-black ground, and the plate's `#33363D` disappears against it — an
  // `unknown` waiter would be counted by the row and invisible on it.
  grey: "#767B85",
};

/** The pip row's geometry, lifted from the prototype: radius, pitch, baseline. */
const PIP_RADIUS = 4;
const PIP_GAP = 11;
const PIP_ELLIPSIS_GAP = 13;
const PIP_ROW_Y = 59;

/** Where the body sits with and without a pip row under it. */
const BODY_Y = 44;
const BODY_Y_WITH_PIPS = 38;

/** Nameplate glyphs are 9px; this many fit across the 72px strip with margins. */
const NAMEPLATE_MAX_CHARS = 13;

/**
 * The nameplate text's centre line — 3px below the strip's own centre. Sitting
 * it on the geometric centre reads high on the device, because the glyphs the
 * plate carries are mostly x-height with no descenders to balance them.
 */
const NAMEPLATE_TEXT_Y = 10;

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

/**
 * The row of pips for the other waiters, centred under the body — or nothing at
 * all when the target is the only thing waiting.
 *
 * The row is centred on the whole thing it draws, ellipsis included, so a tile
 * that overflows does not look off-centre.
 */
function pipRow(face: FaceDescriptor): string {
  if (face.pips.length === 0) return "";
  const width = (face.pips.length - 1) * PIP_GAP + (face.pipOverflow ? PIP_ELLIPSIS_GAP : 0);
  const first = SIZE / 2 - width / 2;
  const dots = face.pips
    .map(
      (pip, i) =>
        `<circle cx="${first + i * PIP_GAP}" cy="${PIP_ROW_Y}" r="${PIP_RADIUS}"` +
        ` fill="${PIP_FILL[pip]}"/>`,
    )
    .join("");
  const more = face.pipOverflow
    ? textNode(
        "…",
        first + (face.pips.length - 1) * PIP_GAP + PIP_ELLIPSIS_GAP,
        PIP_ROW_Y - 2,
        18,
        PALETTE[face.stateColour].bodyInk,
      )
    : "";
  return dots + more;
}

/** Render a face as a complete 72×72 SVG document, ready for `setImage`. */
export function renderFaceSvg(face: FaceDescriptor): string {
  const palette = PALETTE[face.stateColour];
  // The body rides up to make room for the pips rather than the row appearing
  // over it — the tile has one column of space and the two share it.
  const bodyY = face.pips.length > 0 ? BODY_Y_WITH_PIPS : BODY_Y;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"` +
    ` viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<rect width="${SIZE}" height="${SIZE}" fill="${GROUND}"/>` +
    `<rect width="${SIZE}" height="${NAMEPLATE_HEIGHT}" fill="${palette.plate}"/>` +
    textNode(
      clip(face.nameplate, NAMEPLATE_MAX_CHARS),
      SIZE / 2,
      NAMEPLATE_TEXT_Y,
      9,
      palette.plateInk,
    ) +
    textNode(face.body, SIZE / 2, bodyY, fitSize(face.body), palette.bodyInk) +
    pipRow(face) +
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
