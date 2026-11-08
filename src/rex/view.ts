/**
 * The parts of a Rex `session.view` and of a terminal block's methods that the
 * plugin reads.
 *
 * A **narrowed view**, like `src/herdr/snapshot.ts`: each field is here because
 * the conversion reads it, and each collection the server may leave out or send
 * as `null` is optional, so the types say what the conversion must survive.
 * Shapes are from `docs/research/rex-control-api.md` and a live server's
 * `rex api describe`.
 */

/** The block creator whose blocks are terminals, and so the only ones with a status. */
export const TERMINAL_CREATOR = "com.superlogical.terminal";

/** The terminal block methods the poll calls, by their full names. */
export const PROGRAM_STATUS_METHOD = `${TERMINAL_CREATOR}.program_status`;
export const TITLE_METHOD = `${TERMINAL_CREATOR}.title`;

/**
 * One node of a layer's layout tree. A leaf carries `block_id`; an inner node
 * carries `split` instead, with the two halves under `before` and `after`. Every
 * node has a `rect` of `[x, y, w, h]`, as fractions of the window.
 */
export interface LayoutNode {
  readonly rect: readonly number[];
  readonly block_id?: string | null;
  readonly split?: {
    readonly before: LayoutNode;
    readonly after: LayoutNode;
  } | null;
}

export interface ViewBlock {
  readonly block_id: string;
  readonly creator_name?: string;
}

export interface ViewLayer {
  /** `tiled` for the window's own layout; anything else floats over it. */
  readonly kind: string;
  readonly layout?: LayoutNode | null;
  readonly blocks?: readonly ViewBlock[] | null;
}

export interface ViewWindow {
  readonly window_id: string;
  readonly label?: string;
  readonly focused_block_id?: string | null;
  readonly layers?: readonly ViewLayer[] | null;
}

/** A `session.view` result. */
export interface SessionView {
  readonly windows?: readonly ViewWindow[] | null;
}

/** One entry of a terminal's `program_status` records. */
export interface StatusRecord {
  /** Absent for the root record; a slash separates parent from child. */
  readonly id?: string;
  readonly state: string;
  /** RFC 3339, the server's clock. */
  readonly updated_at: string;
  /** What the program called itself; a child record may carry only `effective_app`. */
  readonly app?: string;
  readonly effective_app?: string;
}

/** What the poll learns about one terminal block, beyond the view. */
export interface BlockReport {
  readonly records: readonly StatusRecord[];
  /** The terminal's title; empty when none is set. */
  readonly title: string;
}
