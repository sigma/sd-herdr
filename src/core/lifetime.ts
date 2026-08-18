/**
 * Where one herdr **server lifetime** ends and the next begins.
 *
 * The marker is a `terminal_id` that changed under a stable `pane_id`: topology
 * survives a lifetime, `terminal_id` does not — it is regenerated for every
 * pane, every time, and is constant across every poll within one lifetime
 * (`docs/research/herdr-restart-settling.md` §1). It is exact and free, riding
 * in the snapshot already being polled.
 *
 * It supersedes an earlier `state_change_seq`-regression rule, which had two
 * blind spots: nothing regresses when every agent vanishes, and nothing
 * regresses when the max seq was already 0. Both are ordinary here.
 */
import type { Snapshot } from "../herdr/snapshot.js";

/**
 * The snapshot's `pane_id → terminal_id` map.
 *
 * Built from `panes[]` rather than `agents[]` on purpose. A boundary's first
 * observable is `agents[]` emptying — herdr does not restore agent identity —
 * so a detector reading the agent list would go blind at exactly the moment it
 * is meant to fire.
 */
export function terminalsOf(snapshot: Snapshot): ReadonlyMap<string, string> {
  return new Map((snapshot.panes ?? []).map((pane) => [pane.pane_id, pane.terminal_id]));
}

/**
 * Whether the server restarted between these two maps.
 *
 * Only panes present in *both* are evidence: a pane that appeared brings a new
 * `terminal_id` of its own and says nothing about a lifetime, and a pane that
 * went away was closed. So an empty intersection — the first snapshot, or a
 * snapshot with no `panes[]` — is "no", never "yes".
 */
export function isRestart(
  previous: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
): boolean {
  for (const [paneId, terminalId] of next) {
    const was = previous.get(paneId);
    if (was !== undefined && was !== terminalId) return true;
  }
  return false;
}
