/**
 * The parts of a herdr `session.snapshot` the plugin reads.
 *
 * This is a **narrowed view**, not a transcription of the wire format. Each
 * collection is narrowed to the fields some ticket actually reads, so that the
 * type file says what the plugin depends on rather than what herdr happens to
 * send. The fixtures under `fixtures/` carry the full shape either way.
 */

/**
 * An agent status as herdr *reports* it. `done` is not a state an agent can be
 * in — herdr derives it from `(idle, seen = false)` — so it appears only in the
 * outbound direction.
 */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** One entry of `snapshot.agents`, already filtered by herdr to agent-hosting panes. */
export interface SnapshotAgent {
  readonly pane_id: string;
  readonly workspace_id: string;
  readonly tab_id: string;
  readonly terminal_id: string;
  /**
   * The detected or reported agent kind. Optional because the attention model
   * is defined in terms of its presence: an `unknown` pane is attention only if
   * it carries one.
   */
  readonly agent?: string;
  readonly agent_status: AgentStatus;
  /**
   * Session-wide monotonic counter, bumped on every status change, so the
   * lowest value is the longest wait. It restarts at 0 on server start and is
   * not restored, making it comparable only *within* one server lifetime.
   */
  readonly state_change_seq: number;
}

/**
 * One entry of `snapshot.workspaces`. Only the label is read: it is what the
 * face's body names, because a workspace is the unit a user recognises a piece
 * of work by.
 */
export interface SnapshotWorkspace {
  readonly workspace_id: string;
  readonly label: string;
}

/**
 * One entry of `snapshot.panes` — **every** pane, agent-hosting or not.
 *
 * Read for one thing: the `pane_id → terminal_id` pairing that detects a server
 * lifetime boundary. It has to come from here rather than from `agents[]`,
 * because the boundary's first observable is `agents[]` emptying — a detector
 * reading the agent list would go blind at exactly the moment it is needed.
 */
export interface SnapshotPane {
  readonly pane_id: string;
  /** Regenerated every server lifetime, while `pane_id` survives. */
  readonly terminal_id: string;
}

/** A pane's position within its tab. Only the origin is read; the sort is by `(y, x)`. */
export interface LayoutRect {
  readonly x: number;
  readonly y: number;
}

/** One pane of a tab's layout. */
export interface LayoutPane {
  readonly pane_id: string;
  readonly rect: LayoutRect;
}

/**
 * One entry of `snapshot.layouts`: a tab's geometry, one per tab. This is where
 * the pane index comes from — `pane.layout` cannot answer for it, because it
 * ignores its `tab_id` parameter and only ever describes the focused tab.
 */
export interface SnapshotLayout {
  readonly tab_id: string;
  readonly panes: readonly LayoutPane[];
}

/**
 * A `session.snapshot` result, narrowed to what the plugin reads.
 *
 * Everything but `agents` is optional, because the derived fixtures carry only
 * the collections their scenario exercises — and because every reader here
 * degrades honestly without it: no workspace label falls back to the id, and no
 * layout means no pane index.
 */
export interface Snapshot {
  readonly version: string;
  readonly protocol: number;
  readonly agents: readonly SnapshotAgent[];
  readonly workspaces?: readonly SnapshotWorkspace[];
  readonly panes?: readonly SnapshotPane[];
  readonly layouts?: readonly SnapshotLayout[];
}
