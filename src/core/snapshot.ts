/**
 * What the core reads of a session, whichever multiplexer it came from.
 *
 * Owned by the core and deliberately smaller than any wire format: each field
 * is here because the attention model, the press cycle or the face reads it. A
 * backend converts its own protocol into this with a pure function, so a
 * protocol change shows up as a failing conversion test rather than as policy
 * drift in the core.
 */

/**
 * An agent's status. `done` is not a state an agent can be in on herdr — it is
 * derived from `(idle, seen = false)` — so it exists only as something a
 * backend reports.
 */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** One agent-hosting pane. */
export interface Agent {
  readonly paneId: string;
  readonly tabId: string;
  /** What the body names: the unit a user recognises a piece of work by. */
  readonly groupId: string;
  readonly status: AgentStatus;
  /**
   * Lower means waited longer. Comparable only within one lifetime and within
   * one snapshot's agents; the core never reads it as a time.
   */
  readonly waitKey: number;
}

/** A group's display label. Absent means the body falls back to the id. */
export interface GroupLabel {
  readonly groupId: string;
  readonly label: string;
}

/** A pane's origin within its tab. The pane index sorts by `(y, x)`. */
export interface PaneOrigin {
  readonly paneId: string;
  readonly x: number;
  readonly y: number;
}

/** One tab's geometry: **every** pane in it, agent or not. */
export interface TabLayout {
  readonly tabId: string;
  readonly panes: readonly PaneOrigin[];
}

/**
 * What tells the core a server lifetime ended: a set of witnesses, each a key
 * with a token that is stable within a lifetime and changes across one. The
 * core reads a changed token under a key present in both snapshots as a restart.
 *
 * herdr's witnesses are `pane_id → terminal_id`, one per pane. A backend with a
 * single server-wide instance id carries it as one entry; the comparison is the
 * same.
 */
export type LifetimeMarker = ReadonlyMap<string, string>;

/** A session at one instant, as the core sees it. */
export interface Snapshot {
  readonly agents: readonly Agent[];
  /** Absent when the backend sent none; the body then names the group id. */
  readonly groups?: readonly GroupLabel[];
  /** Absent when the backend sent none; the body then carries no pane index. */
  readonly layouts?: readonly TabLayout[];
  /** Absent when the backend cannot say; that never reads as a restart. */
  readonly lifetime?: LifetimeMarker;
}
