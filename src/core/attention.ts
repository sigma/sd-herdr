/**
 * The attention set: which agents the button is speaking for, in the order it
 * speaks for them.
 */
import type { Agent } from "./snapshot.js";

/** A status that puts an agent in the attention set. */
export type AttentionStatus = "blocked" | "done" | "working" | "unknown";

/**
 * The ranks of the priority order. Membership of this table *is* the definition
 * of attention: `idle` is absent because it is the one status that says
 * "already looked at, no follow-up" — there is nothing left to walk to.
 *
 * The ranks differ mechanically, not merely in urgency: focusing a `done` agent
 * consumes it (herdr's own `seen`, or on Rex the core's shown mark, since Rex
 * keeps `done` until the agent's next turn), focusing a `blocked` agent changes
 * nothing, a `working` agent is not waiting on the user at all — it is
 * somewhere to *check on* rather than somewhere owed an answer — and an
 * `unknown` agent is one the plugin cannot speak for at all.
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
  readonly groupId: string;
  readonly status: AttentionStatus;
  /** Lower is a longer wait. */
  readonly seq: number;
}

function isAttention(agent: Agent): agent is Agent & { status: AttentionStatus } {
  return agent.status in TIER;
}

/**
 * The attention set in priority order: tier `blocked` → `done` → `working` →
 * `unknown`, then lowest `waitKey` first within a tier, so the longest
 * wait wins.
 *
 * Comparable only within one server lifetime — herdr's `state_change_seq`, for
 * one, restarts at 0 when the server does.
 */
export function attentionSet(agents: readonly Agent[]): readonly AttentionAgent[] {
  return agents
    .filter(isAttention)
    .map(
      (agent): AttentionAgent => ({
        paneId: agent.paneId,
        tabId: agent.tabId,
        groupId: agent.groupId,
        status: agent.status,
        seq: agent.waitKey,
      }),
    )
    .sort((x, y) => TIER[x.status] - TIER[y.status] || x.seq - y.seq);
}
