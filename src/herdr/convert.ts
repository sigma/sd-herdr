import type { Agent, Snapshot as NeutralSnapshot } from "../core/snapshot.js";
import type { Snapshot, SnapshotAgent } from "./snapshot.js";

/**
 * Whether a wire agent is one the core should hear about at all.
 *
 * "There are agents and I cannot tell what they are doing" is only meaningful
 * about a pane that *has* an agent. A plain shell reporting `unknown` is just a
 * shell. herdr already filters `agents[]` this way; the guard is here so that
 * the attention model does not depend on it continuing to.
 */
function isAgent(agent: SnapshotAgent): boolean {
  return !(agent.agent_status === "unknown" && agent.agent === undefined);
}

/**
 * herdr's `session.snapshot` into the core's neutral snapshot. Pure.
 *
 * `workspace_id` is the group the body names, and `state_change_seq` is the
 * wait key: session-wide and monotonic, so the lowest is the longest wait.
 *
 * The lifetime marker is the `pane_id → terminal_id` map, built from `panes[]`
 * rather than `agents[]` on purpose. A boundary's first observable is
 * `agents[]` emptying — herdr does not restore agent identity — so a marker
 * read off the agent list would go blind at exactly the moment it is needed.
 * `terminal_id` is regenerated every server lifetime while `pane_id` survives.
 */
export function fromHerdr(wire: Snapshot): NeutralSnapshot {
  return {
    agents: wire.agents.filter(isAgent).map(
      (agent): Agent => ({
        paneId: agent.pane_id,
        tabId: agent.tab_id,
        groupId: agent.workspace_id,
        status: agent.agent_status,
        waitKey: agent.state_change_seq,
      }),
    ),
    groups: wire.workspaces?.map((w) => ({ groupId: w.workspace_id, label: w.label })),
    layouts: wire.layouts?.map((layout) => ({
      tabId: layout.tab_id,
      panes: layout.panes.map((pane) => ({
        paneId: pane.pane_id,
        x: pane.rect.x,
        y: pane.rect.y,
      })),
    })),
    lifetime:
      wire.panes === undefined
        ? undefined
        : new Map(wire.panes.map((pane) => [pane.pane_id, pane.terminal_id])),
  };
}
