/**
 * The tile's body line: **where the next press will take you**.
 *
 * Not the most urgent agent — that one never moves. Focusing a `blocked` agent
 * consumes nothing, so a body naming the head of the attention set sits
 * unchanged across a whole cycle of them, and the tile stops answering the only
 * question a press is about. The body follows the button; the bar keeps
 * urgency, and the two are allowed to disagree.
 *
 * The body changing as you step is also the only sign of where in the cycle a
 * press has got to — the tile has no other room to say it.
 */
import type { Snapshot } from "../herdr/snapshot.js";
import type { AttentionAgent } from "./attention.js";

/**
 * The pane index's glyphs. Circled numerals rather than a bare digit, so the
 * index cannot be read as part of the workspace label — a workspace called `2`
 * is an ordinary name.
 */
const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];

/** A tab holding more panes than there are glyphs still has to say which one. */
function circled(index: number): string {
  return CIRCLED[index - 1] ?? `·${index}`;
}

/**
 * The target's 1-based position among **every** pane in its tab, agent or
 * shell, in geometric order — or null when the snapshot cannot say.
 *
 * It counts panes rather than agents so that the number names what is on
 * screen, which is the only thing a user can check it against: an
 * `agent | shell | agent` tab reads ① and ③. It is **never** derived from the
 * `pane_id`, whose suffixes are neither contiguous nor ordered.
 */
export function paneIndex(snapshot: Snapshot, tabId: string, paneId: string): number | null {
  const layout = snapshot.layouts?.find((entry) => entry.tab_id === tabId);
  if (layout === undefined) return null;
  const ordered = [...layout.panes].sort((x, y) => x.rect.y - y.rect.y || x.rect.x - y.rect.x);
  const at = ordered.findIndex((pane) => pane.pane_id === paneId);
  return at < 0 ? null : at + 1;
}

/** The workspace's label, falling back to its id when the snapshot carries no labels. */
function workspaceLabel(snapshot: Snapshot, workspaceId: string): string {
  return (
    snapshot.workspaces?.find((workspace) => workspace.workspace_id === workspaceId)?.label ??
    workspaceId
  );
}

/**
 * The body line for a press target: its workspace label, plus a pane index when
 * — and only when — an **attention sibling** shares its tab.
 *
 * A plain shell alongside the target is not a sibling and buys no index: the
 * press can still only go to the one agent, so the label is already
 * unambiguous. The common case therefore renders a bare workspace label, and
 * the index blinks — consume the sibling and the label goes back to being
 * bare. That is paying only where it is needed, working as intended.
 *
 * Empty for no target: a dark or grey tile has nowhere to send a press.
 */
export function bodyFor(
  snapshot: Snapshot,
  ordered: readonly AttentionAgent[],
  targetPaneId: string | null,
): string {
  const target = ordered.find((agent) => agent.paneId === targetPaneId);
  if (target === undefined) return "";

  const label = workspaceLabel(snapshot, target.workspaceId);
  const hasSibling = ordered.some(
    (agent) => agent.tabId === target.tabId && agent.paneId !== target.paneId,
  );
  if (!hasSibling) return label;

  const index = paneIndex(snapshot, target.tabId, target.paneId);
  // No geometry, no index: a number the user cannot check against the screen
  // would be worse than the ambiguity it claims to resolve.
  return index === null ? label : `${label} ${circled(index)}`;
}
