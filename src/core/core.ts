/**
 * The seam. All of the plugin's policy lives behind two pure functions:
 *
 * ```
 * reduce(state, event) -> { state, effects }
 * face(state)          -> FaceDescriptor
 * ```
 *
 * Two properties hold, and every later ticket depends on them:
 *
 * - **Every event carries its own timestamp.** The core never reads a clock, so
 *   a test asserts a deadline by advancing a number rather than sleeping.
 * - **Effects are declarative intents, never calls.** The core decides what
 *   should happen and in what order; the adapters obey. Nothing here opens a
 *   socket, spawns a process, or touches the Stream Deck SDK.
 *
 * Scope, for now, is the attention model and the bar colour. The body, the
 * press cycle and the full grey policy arrive in later tickets against this
 * same seam.
 */
import type { FaceDescriptor, StateColour } from "../face/descriptor.js";
import type { Snapshot } from "../herdr/snapshot.js";
import { type AttentionStatus, attentionSet } from "./attention.js";

/**
 * What each tier of the attention set says the bar should be.
 *
 * `unknown` is grey rather than a colour of its own: "there are agents and I
 * cannot tell what they are doing" is the same thing to a user as "I cannot see
 * the session", and rendering it as dark would be rendering it as all-clear.
 */
const TIER_COLOUR: Record<AttentionStatus, StateColour> = {
  blocked: "red",
  done: "amber",
  unknown: "grey",
};

/**
 * The poll cadence. Each poll is scheduled *after* the previous one completes,
 * so this is a gap between snapshots rather than a fixed rate — a slow herdr
 * cannot pile requests up behind itself.
 */
export const POLL_INTERVAL_MS = 1000;

/** What the world tells the core. Every event carries the time it happened. */
export type CoreEvent =
  | { readonly type: "appeared"; readonly at: number }
  | { readonly type: "disappeared"; readonly at: number }
  | { readonly type: "snapshotTaken"; readonly at: number; readonly snapshot: Snapshot }
  | { readonly type: "snapshotFailed"; readonly at: number }
  | { readonly type: "pollDue"; readonly at: number };

/** What the core asks the world for. Data — the adapters decide how. */
export type Effect =
  | { readonly type: "snapshot"; readonly socketPath: string }
  | { readonly type: "pollAfter"; readonly ms: number };

/**
 * The core's state. Deliberately not part of the tested contract: tests drive
 * events in and assert on effects and on `face`, so this can grow a visited
 * set, a settle deadline and a backoff without rewriting them.
 */
export interface CoreState {
  readonly sessionName: string;
  /**
   * The socket answering for that session. Computed once from the session name
   * and fixed for the button's life: it is a path convention, not a lookup, so
   * there is nothing to re-resolve. Whether anything is listening on it is the
   * snapshot's business.
   */
  readonly socketPath: string;
  /** Whether the button is on screen. Nothing is polled while it is not. */
  readonly visible: boolean;
  /** The last snapshot seen, or null for "cannot see the session". */
  readonly snapshot: Snapshot | null;
  /** When the last event happened. The core's only notion of time. */
  readonly at: number;
}

/** A core that has not seen anything yet. */
export function initial(sessionName: string, socketPath: string): CoreState {
  return { sessionName, socketPath, visible: false, snapshot: null, at: 0 };
}

/** Ask for a snapshot — but only while anyone is looking. */
function probe(state: CoreState): Effect[] {
  return state.visible ? [{ type: "snapshot", socketPath: state.socketPath }] : [];
}

/** Come back in a beat — but only while anyone is looking. */
function schedulePoll(state: CoreState): Effect[] {
  return state.visible ? [{ type: "pollAfter", ms: POLL_INTERVAL_MS }] : [];
}

/** Fold one event into the state, and say what should happen next. */
export function reduce(
  state: CoreState,
  event: CoreEvent,
): { readonly state: CoreState; readonly effects: readonly Effect[] } {
  const at = event.at;

  switch (event.type) {
    case "appeared": {
      // A second willAppear for a button already on screen must not start a
      // second poll chain running alongside the first.
      if (state.visible) return { state: { ...state, at }, effects: [] };
      const next = { ...state, visible: true, at };
      return { state: next, effects: probe(next) };
    }

    case "disappeared":
      return { state: { ...state, visible: false, at }, effects: [] };

    case "snapshotTaken": {
      const next = { ...state, snapshot: event.snapshot, at };
      return { state: next, effects: schedulePoll(next) };
    }

    case "snapshotFailed": {
      // Nothing to give up on: the socket path is a convention rather than a
      // discovery, so a session that comes back comes back on the same path.
      // Failure means "keep asking".
      //
      // The last snapshot is *kept*. One dropped poll is not "cannot see the
      // session": the face goes grey on a staleness deadline, measured from the
      // last good snapshot, rather than on a failure count. That deadline is
      // #21's, and it is what eventually retires the face this holds on to.
      const next = { ...state, at };
      return { state: next, effects: schedulePoll(next) };
    }

    case "pollDue": {
      const next = { ...state, at };
      return { state: next, effects: probe(next) };
    }
  }
}

/**
 * What the tile should show. Pure, and derived only from state — so the same
 * state always draws the same face.
 */
export function face(state: CoreState): FaceDescriptor {
  if (state.snapshot === null) {
    // Grey is the one "cannot see anything" state, and is never all-clear. The
    // nameplate falls back to `herdr` because with no snapshot the plugin
    // cannot verify the session name it was configured with.
    //
    // Two of grey's causes are handled: no snapshot yet, here, and an
    // unknown-only attention set, below. The staleness deadline and the
    // settling window are #21's — until they land, a face outlives the last
    // good snapshot rather than aging out of it.
    return { stateColour: "grey", nameplate: "herdr", body: "" };
  }

  // The attention set is already in priority order, so its head is the most
  // urgent thing in the session and its tier is the colour. Reading the colour
  // off the same ordering the press cycle uses keeps one table in charge of
  // both, rather than a second cascade that has to be kept in step with it.
  const head = attentionSet(state.snapshot.agents)[0];

  return {
    stateColour: head === undefined ? "dark" : TIER_COLOUR[head.status],
    // `default` is herdr's placeholder rather than a name the user chose, so
    // the slot buys product identity instead. Note that grey keeps the real
    // name here: the `herdr` fallback above is for a face that could not *see*
    // the session, and a snapshot full of `unknown` agents still verifies it.
    nameplate: state.sessionName === "default" ? "herdr" : state.sessionName,
    // The body names the next press target, and there is no press cycle yet.
    // #24 fills this in against this same seam.
    body: "",
  };
}
