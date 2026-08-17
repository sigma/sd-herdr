/**
 * The parts of a herdr `session.snapshot` the plugin reads.
 *
 * This is a **narrowed view**, not a transcription of the wire format. A real
 * snapshot also carries `workspaces`, `tabs`, `panes` and `layouts`; they are
 * left untyped until a ticket actually reads them, so that the type file says
 * what the plugin depends on rather than what herdr happens to send. The
 * fixtures under `fixtures/` carry the full shape either way.
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

/** A `session.snapshot` result, narrowed to what the plugin reads. */
export interface Snapshot {
  readonly version: string;
  readonly protocol: number;
  readonly agents: readonly SnapshotAgent[];
}
