import type { Agent, AgentStatus, PaneOrigin, Snapshot, TabLayout } from "../core/snapshot.js";
import type {
  BlockReport,
  LayoutNode,
  SessionView,
  StatusRecord,
  ViewBlock,
  ViewWindow,
} from "./view.js";

/**
 * A record's state as the core's status. Rex has no `unknown`, so a state this
 * build does not know reads `idle`, as the schema requires of a client; `error`
 * is `blocked`, because something that failed needs the user exactly as
 * something that asked does (map decision: red, no new colour).
 */
function statusOf(state: string): AgentStatus {
  switch (state) {
    case "blocked":
    case "error":
      return "blocked";
    case "done":
    case "working":
    case "idle":
      return state;
    default:
      return "idle";
  }
}

/** Most urgent first, in the tile's own order. `idle` is last: it is not attention. */
const URGENCY: Record<AgentStatus, number> = {
  blocked: 0,
  done: 1,
  working: 2,
  unknown: 3,
  idle: 4,
};

/** A record's `updated_at` as a wait key; an unreadable one waits last. */
function waitKeyOf(record: StatusRecord): number {
  const at = Date.parse(record.updated_at);
  return Number.isNaN(at) ? Number.MAX_SAFE_INTEGER : at;
}

/**
 * A block's status and wait key: the most urgent of its records, and within a
 * tier the longest-waiting. A block's records nest (`build`, `build/test`), and
 * the user is owed whichever of them needs them most, whatever its depth.
 * Null for a block that is not an agent: no record has an `effective_app`.
 */
function collapse(
  records: readonly StatusRecord[],
): { status: AgentStatus; waitKey: number } | null {
  if (
    !records.some((record) => record.effective_app !== undefined && record.effective_app !== "")
  ) {
    return null;
  }
  let best: { status: AgentStatus; waitKey: number } | null = null;
  for (const record of records) {
    const candidate = { status: statusOf(record.state), waitKey: waitKeyOf(record) };
    if (
      best === null ||
      URGENCY[candidate.status] < URGENCY[best.status] ||
      (candidate.status === best.status && candidate.waitKey < best.waitKey)
    ) {
      best = candidate;
    }
  }
  return best;
}

/** The label Rex gives a window nobody named, computed from its id. */
export function defaultWindowLabel(windowId: string): string {
  return `Window ${windowId.slice(-8)}`;
}

/** Every block of a window, from every layer, in document order. */
function blocksOf(window: ViewWindow): readonly ViewBlock[] {
  return (window.layers ?? []).flatMap((layer) => layer.blocks ?? []);
}

/**
 * What the body names a window.
 *
 * The window's own label when someone chose it. Rex gives an unnamed window
 * `Window <last 8 of its id>` and shows such a tab under its terminal's title
 * instead, so the body does the same: compared against the string computed from
 * the id, not pattern-matched.
 *
 * A label belongs to a window and a title to a block, so a window holding
 * several agents needs a choice. The window's focused block comes first if it
 * is an agent with a title (it is the terminal the app shows the tab by), then
 * the first agent in document order that has one. A window with no titled agent
 * keeps its default label, which is at least stable.
 */
function labelOf(window: ViewWindow, agents: ReadonlyMap<string, { title: string }>): string {
  const label = window.label ?? "";
  if (label !== "" && label !== defaultWindowLabel(window.window_id)) return label;

  const focused = window.focused_block_id ?? null;
  const candidates = blocksOf(window)
    .map((block) => block.block_id)
    .filter((id) => agents.has(id));
  const ordered =
    focused !== null && candidates.includes(focused)
      ? [focused, ...candidates.filter((id) => id !== focused)]
      : candidates;
  for (const id of ordered) {
    const title = agents.get(id)?.title ?? "";
    if (title !== "") return title;
  }
  return label !== "" ? label : window.window_id;
}

/** The leaves of a layout tree, each at its rect's origin. */
function leaves(node: LayoutNode | null | undefined): PaneOrigin[] {
  if (node === null || node === undefined) return [];
  if (node.split !== null && node.split !== undefined) {
    return [...leaves(node.split.before), ...leaves(node.split.after)];
  }
  if (node.block_id === null || node.block_id === undefined) return [];
  const [x = 0, y = 0] = node.rect;
  return [{ paneId: node.block_id, x, y }];
}

/**
 * A Rex `session.view`, with the poll's per-block reports, into the core's
 * neutral snapshot. Pure.
 *
 * `reports` is keyed by `block_id` and holds the terminal blocks only; a block
 * with no report is not a terminal and so not an agent. Detached blocks are not
 * in the view and so not here.
 *
 * A window is the tab and the group at once, so `tabId` and `groupId` are both
 * its id. The pane index counts the **tiled** layer's layout leaves and nothing
 * on a floating layer: a floating block sits over the tab rather than in the
 * grid the index numbers. Agents are still gathered from every layer, so a
 * blocked agent on a floating layer turns the tile red; it just has no index.
 *
 * No lifetime marker yet: the server's `instance_id` arrives with restart
 * handling, and an absent marker never reads as a restart.
 */
export function fromRex(view: SessionView, reports: ReadonlyMap<string, BlockReport>): Snapshot {
  const windows = view.windows ?? [];
  const agents: Agent[] = [];
  const groups = [];
  const layouts: TabLayout[] = [];

  for (const window of windows) {
    const windowAgents = new Map<string, { title: string }>();
    for (const block of blocksOf(window)) {
      const report = reports.get(block.block_id);
      if (report === undefined) continue;
      const collapsed = collapse(report.records);
      if (collapsed === null) continue;
      windowAgents.set(block.block_id, { title: report.title });
      agents.push({
        paneId: block.block_id,
        tabId: window.window_id,
        groupId: window.window_id,
        ...collapsed,
      });
    }
    groups.push({ groupId: window.window_id, label: labelOf(window, windowAgents) });

    const tiled = (window.layers ?? []).filter((layer) => layer.kind === "tiled");
    if (tiled.length > 0) {
      layouts.push({ tabId: window.window_id, panes: tiled.flatMap((l) => leaves(l.layout)) });
    }
  }

  return {
    agents,
    groups,
    layouts,
    label: view.label === undefined || view.label === "" ? undefined : view.label,
  };
}
