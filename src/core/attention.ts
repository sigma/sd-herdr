/**
 * The attention set: which agents the button is speaking for, in the order it
 * speaks for them.
 */
import type { SnapshotAgent } from "../herdr/snapshot.js";

/** A status that puts an agent in the attention set. */
export type AttentionStatus = "blocked" | "done" | "working" | "unknown";

/**
 * The ranks of the priority order. Membership of this table *is* the definition
 * of attention: `idle` is absent because it is the one status that says
 * "already looked at, no follow-up" — there is nothing left to walk to.
 *
 * The ranks differ mechanically, not merely in urgency: focusing a `done` agent
 * consumes it, focusing a `blocked` agent changes nothing, a `working` agent is
 * not waiting on the user at all — it is somewhere to *check on* rather than
 * somewhere owed an answer — and an `unknown` agent is one the plugin cannot
 * speak for at all.
 */
export const TIER: Record<AttentionStatus, number> = {
  blocked: 0,
  done: 1,
  working: 2,
  unknown: 3,
};

/** One member of the attention set, narrowed to what selection and the face need. */
export interface AttentionAgent {
  readonly paneId: string;
  readonly tabId: string;
  readonly workspaceId: string;
  readonly status: AttentionStatus;
  /** Lower is a longer wait. */
  readonly seq: number;
}

function isAttention(
  agent: SnapshotAgent,
): agent is SnapshotAgent & { agent_status: AttentionStatus } {
  if (!(agent.agent_status in TIER)) return false;
  // "There are agents and I cannot tell what they are doing" is only meaningful
  // about a pane that *has* an agent. A plain shell reporting `unknown` is just
  // a shell. herdr already filters `agents[]` this way; the guard is here so
  // that the model does not depend on it continuing to.
  if (agent.agent_status === "unknown" && agent.agent === undefined) return false;
  return true;
}

/**
 * The attention set in priority order: tier `blocked` → `done` → `working` →
 * `unknown`, then lowest `state_change_seq` first within a tier, so the longest
 * wait wins.
 *
 * Comparable only within one server lifetime — `state_change_seq` restarts at 0
 * when herdr does.
 */
export function attentionSet(agents: readonly SnapshotAgent[]): readonly AttentionAgent[] {
  return agents
    .filter(isAttention)
    .map(
      (agent): AttentionAgent => ({
        paneId: agent.pane_id,
        tabId: agent.tab_id,
        workspaceId: agent.workspace_id,
        status: agent.agent_status,
        seq: agent.state_change_seq,
      }),
    )
    .sort((x, y) => TIER[x.status] - TIER[y.status] || x.seq - y.seq);
}
