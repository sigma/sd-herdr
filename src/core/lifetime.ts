/**
 * Where one **server lifetime** ends and the next begins.
 *
 * The snapshot carries a lifetime marker (see `LifetimeMarker`) and a restart is
 * a token that changed under a key present in both. For herdr that is a
 * `terminal_id` that changed under a stable `pane_id`: topology survives a
 * lifetime, `terminal_id` does not — it is regenerated for every pane, every
 * time, and is constant across every poll within one lifetime
 * (`docs/research/herdr-restart-settling.md` §1). It is exact and free, riding
 * in the snapshot already being polled.
 *
 * It supersedes an earlier `state_change_seq`-regression rule, which had two
 * blind spots: nothing regresses when every agent vanishes, and nothing
 * regresses when the max seq was already 0. Both are ordinary here.
 */
import type { LifetimeMarker, Snapshot } from "./snapshot.js";

/** The snapshot's lifetime marker, empty when it carries none. */
export function lifetimeOf(snapshot: Snapshot): LifetimeMarker {
  return snapshot.lifetime ?? new Map();
}

/**
 * Whether the server restarted between these two maps.
 *
 * Only keys present in *both* are evidence: a pane that appeared brings a new
 * `terminal_id` of its own and says nothing about a lifetime, and a pane that
 * went away was closed. So an empty intersection — the first snapshot, or a
 * snapshot with no marker — is "no", never "yes".
 */
export function isRestart(previous: LifetimeMarker, next: LifetimeMarker): boolean {
  for (const [key, token] of next) {
    const was = previous.get(key);
    if (was !== undefined && was !== token) return true;
  }
  return false;
}
