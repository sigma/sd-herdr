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
 * Scope is the attention model, the bar colour, the press cycle and the face
 * the three of them add up to.
 */
import {
  type FaceDescriptor,
  PIP_CAP,
  type PipColour,
  type StateColour,
} from "../face/descriptor.js";
import { DEFAULT_SESSION } from "../herdr/session.js";
import type { Snapshot } from "../herdr/snapshot.js";
import { type AttentionAgent, type AttentionStatus, attentionSet } from "./attention.js";
import { bodyFor } from "./body.js";
import { isRestart, terminalsOf } from "./lifetime.js";

/**
 * What each tier of the attention set says the bar should be.
 *
 * Green is `done` and amber is `working`, not the other way round: amber is the
 * colour of something still in flight, and a finished agent has nothing left to
 * wait for. So the two urgent tiers read as a traffic light — red stopped,
 * amber running, green arrived.
 *
 * `unknown` is grey rather than a colour of its own: "there are agents and I
 * cannot tell what they are doing" is the same thing to a user as "I cannot see
 * the session", and rendering it as dark would be rendering it as all-clear.
 */
const TIER_COLOUR: Record<AttentionStatus, PipColour> = {
  blocked: "red",
  done: "green",
  working: "amber",
  unknown: "grey",
};

/**
 * The poll cadence. Each poll is scheduled *after* the previous one completes,
 * so this is a gap between snapshots rather than a fixed rate — a slow herdr
 * cannot pile requests up behind itself.
 */
export const POLL_INTERVAL_MS = 1000;

/**
 * How old the last good snapshot may get before the face stops being trusted.
 *
 * This is a **deadline on the age of the data**, not a count of failures, and
 * the difference is the point: a failure counter cannot notice a poll that
 * wedged without ever coming back, so a stalled loop would keep rendering a
 * confidently green face forever. Measuring age notices, because a wedged loop
 * produces no events *at all* — which is what the heartbeat below is for.
 */
export const STALENESS_DEADLINE_MS = 3000;

/**
 * How long the face is held grey after a server lifetime boundary, before the
 * data is trusted again.
 *
 * **Deliberately a separate constant from the staleness deadline.** They answer
 * different questions — one asks whether the data is recent, the other whether
 * a herdr that has just come back has finished making sense — and tying them
 * together would make a change to either a silent change to the other.
 *
 * Sized for the slower of the two boundary shapes, because they are
 * indistinguishable at the moment they happen: a live handoff brings agents
 * back at ~0.4 s but correct statuses only at ~3.74 s, since re-detected state
 * is seeded `Idle` under a 3 s startup grace window
 * (`docs/research/herdr-detected-agent-restart.md`). A stop/restart resolves to
 * nothing at all, and 4 s of grey before an honest dark tile costs nothing.
 */
export const SETTLE_WINDOW_MS = 4000;

/**
 * The longest gap between retries. Failures back off — one unreachable socket
 * should not mean one request a second for however long herdr is down — but a
 * session that comes back must light the tile up again without the user
 * touching it, so the backoff flattens out rather than growing without bound.
 */
export const BACKOFF_CEILING_MS = 5000;

/**
 * The heartbeat: how often the core is handed the current time with no other
 * news. Nothing is asked of herdr on a tick; it exists so that the staleness
 * deadline can pass while *nothing at all* is happening, which is exactly the
 * wedged-poll case. Its period is the lag between crossing the deadline and
 * showing it, and half a second of that is imperceptible on a glanceable tile.
 */
export const TICK_INTERVAL_MS = 500;

/** What the world tells the core. Every event carries the time it happened. */
export type CoreEvent =
  | { readonly type: "appeared"; readonly at: number }
  | { readonly type: "disappeared"; readonly at: number }
  | { readonly type: "snapshotTaken"; readonly at: number; readonly snapshot: Snapshot }
  | { readonly type: "snapshotFailed"; readonly at: number }
  | { readonly type: "pollDue"; readonly at: number }
  | { readonly type: "tick"; readonly at: number }
  | { readonly type: "pressed"; readonly at: number }
  /**
   * How the focus half of a press went. `ok: false` is `pane_not_found` and
   * every other way a focus can fail: they are indistinguishable on the wire —
   * herdr answers `pane_not_found` for a dead id, a malformed one and one that
   * never existed — so the core does not pretend to tell them apart.
   *
   * Both outcomes provoke the same effect, and the flag is still carried rather
   * than dropped: the visited set records where a press *took* the user, and a
   * focus that never landed took them nowhere.
   */
  | { readonly type: "focusResult"; readonly at: number; readonly ok: boolean };

/** What the core asks the world for. Data — the adapters decide how. */
export type Effect =
  | { readonly type: "snapshot"; readonly socketPath: string }
  /**
   * Ask the server what it is. Issued on startup and on a detected restart
   * **only**, never per poll: it answers a question — which herdr build is on
   * the other end of this socket — that changes exactly when a server lifetime
   * does, and the snapshot poll is already carrying the running cost.
   */
  | { readonly type: "ping"; readonly socketPath: string }
  | { readonly type: "pollAfter"; readonly ms: number }
  | { readonly type: "tickAfter"; readonly ms: number }
  | { readonly type: "setTitle"; readonly socketPath: string; readonly nonce: string }
  | { readonly type: "focusPane"; readonly socketPath: string; readonly paneId: string }
  | { readonly type: "raise"; readonly nonce: string }
  | { readonly type: "clearTitle"; readonly socketPath: string };

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
  /** When that snapshot arrived — what the staleness deadline is measured from. */
  readonly snapshotAt: number;
  /** How many polls in a row have failed. Drives the backoff, and nothing else. */
  readonly failures: number;
  /** How many presses this button has served. Only the nonce reads it. */
  readonly presses: number;
  /**
   * The **pane**-keyed record of which attention panes this cycle has already
   * shown. Pane-keyed rather than tab-keyed because focus is: a tab-keyed set
   * would mark a tiled sibling visited on the press that reached its
   * neighbour, and leave it unreachable by button.
   */
  readonly visited: ReadonlySet<string>;
  /**
   * The pane the press in flight aimed at, held until its focus reports back.
   * A focus that never landed took the user nowhere, so the visit is taken
   * back rather than left to cost the cycle a step.
   */
  readonly aimedAt: string | null;
  /**
   * The last snapshot's `pane_id → terminal_id` map — the whole of what the
   * core remembers about the server lifetime it is talking to.
   */
  readonly terminals: ReadonlyMap<string, string>;
  /**
   * When the settling grey ends, or 0 for "not settling". A deadline rather
   * than a flag, for the same reason staleness is: it is answered by comparing
   * two numbers the events carry, and nothing has to be cancelled.
   */
  readonly settlingUntil: number;
  /** When the last event happened. The core's only notion of time. */
  readonly at: number;
}

/** One shared empty set, so an untouched cycle allocates nothing. */
const NO_PANES: ReadonlySet<string> = new Set();

/** The same, for a core that has not seen a snapshot yet. */
const NO_TERMINALS: ReadonlyMap<string, string> = new Map();

/** A core that has not seen anything yet. */
export function initial(sessionName: string, socketPath: string): CoreState {
  return {
    sessionName,
    socketPath,
    visible: false,
    snapshot: null,
    snapshotAt: 0,
    failures: 0,
    presses: 0,
    visited: NO_PANES,
    aimedAt: null,
    terminals: NO_TERMINALS,
    settlingUntil: 0,
    at: 0,
  };
}

/**
 * The visited set, brought back into line with the attention set: panes that
 * have left it are **pruned**, and a set that now covers everything **wraps**.
 *
 * Pruning rather than resetting is the load-bearing detail. An earlier design
 * reset the whole set whenever membership changed, and that rule was the sole
 * cause of `done`-tier starvation — it walked the user back through agents they
 * had just answered every time anything else arrived. It bought nothing a prune
 * does not: a new agent is reachable because it is not in the set.
 *
 * The wrap is settled *here*, on the way in, rather than being discovered by a
 * press that then finds nothing to aim at. So a full set never survives to be
 * seen, and no press is ever spent on the wrap itself.
 */
function settle(
  visited: ReadonlySet<string>,
  ordered: readonly AttentionAgent[],
): ReadonlySet<string> {
  const live = new Set(ordered.map((agent) => agent.paneId));
  const pruned = new Set([...visited].filter((paneId) => live.has(paneId)));
  return pruned.size === live.size ? NO_PANES : pruned;
}

/** The attention set of the snapshot in hand, in priority order. */
function ordered(state: CoreState): readonly AttentionAgent[] {
  return state.snapshot === null ? [] : attentionSet(state.snapshot.agents);
}

/** Ask for a snapshot — but only while anyone is looking. */
function probe(state: CoreState): Effect[] {
  return state.visible ? [{ type: "snapshot", socketPath: state.socketPath }] : [];
}

/** Come back in a beat — but only while anyone is looking. */
function schedulePoll(state: CoreState): Effect[] {
  return state.visible ? [{ type: "pollAfter", ms: backoff(state.failures) }] : [];
}

/** Keep the clock coming — but only while anyone is looking. */
function scheduleTick(state: CoreState): Effect[] {
  return state.visible ? [{ type: "tickAfter", ms: TICK_INTERVAL_MS }] : [];
}

/**
 * How long to wait before the next poll, given how many have failed in a row.
 * Zero failures is the plain cadence; each further one doubles the gap until it
 * hits the ceiling.
 */
function backoff(failures: number): number {
  if (failures === 0) return POLL_INTERVAL_MS;
  return Math.min(POLL_INTERVAL_MS * 2 ** (failures - 1), BACKOFF_CEILING_MS);
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
      // The ping is the startup half of "startup and restart only": it names
      // the server this loop is about to spend its life talking to, and is the
      // only record of a herdr that updated underneath the plugin.
      return {
        state: next,
        effects: [
          { type: "ping", socketPath: next.socketPath },
          ...probe(next),
          ...scheduleTick(next),
        ],
      };
    }

    case "disappeared":
      // One of the cycle's three resets — the others are the wrap and a
      // detected server restart. The visited set is in-memory only and is
      // never persisted: it is a record of one sitting at the keyboard, and
      // restoring it would leave the button starting mid-cycle for reasons the
      // user cannot see.
      return {
        state: { ...state, visible: false, visited: NO_PANES, aimedAt: null, at },
        effects: [],
      };

    case "snapshotTaken": {
      // A good snapshot resets the backoff: the session is answering again, so
      // the next dropped poll starts counting from scratch rather than
      // inheriting a five-second gap from an outage that is over.
      const next = { ...state, snapshot: event.snapshot, snapshotAt: at, failures: 0, at };
      const terminals = terminalsOf(event.snapshot);
      const restarted = isRestart(state.terminals, terminals);

      // A restart is the third of the cycle's three resets — the others are the
      // wrap and `willDisappear`. The panes may well still be there, but the
      // agents in them are new, and a visited set carried across says a user
      // has answered agents that did not exist when they pressed.
      if (restarted) {
        return {
          state: {
            ...next,
            terminals,
            settlingUntil: at + SETTLE_WINDOW_MS,
            visited: NO_PANES,
            aimedAt: null,
          },
          effects: [{ type: "ping", socketPath: next.socketPath }, ...schedulePoll(next)],
        };
      }

      return {
        state: { ...next, terminals, visited: settle(state.visited, ordered(next)) },
        effects: schedulePoll(next),
      };
    }

    case "snapshotFailed": {
      // Nothing to give up on: the socket path is a convention rather than a
      // discovery, so a session that comes back comes back on the same path.
      // There is nothing to re-resolve and nothing to rediscover — failure
      // means "keep asking, less often".
      //
      // The last snapshot is *kept*. One dropped poll is not "cannot see the
      // session": the face goes grey on the staleness deadline, measured from
      // the last good snapshot, rather than on this count. The count decides
      // only how long to wait before trying again.
      const next = { ...state, failures: state.failures + 1, at };
      return { state: next, effects: schedulePoll(next) };
    }

    case "pollDue": {
      const next = { ...state, at };
      return { state: next, effects: probe(next) };
    }

    case "pressed": {
      // The whole press, emitted at once and in order. The adapters obey one
      // effect at a time, so "focus, then raise" is a property of this list
      // rather than of anything the runner decides.
      //
      // The nonce goes out even when there is nothing to focus: the user asked
      // to be taken to the session, and an exact raise still needs a marked
      // window to aim at.
      const stepped = { ...state, presses: state.presses + 1, at };
      const nonce = nonceFor(stepped);
      const target = pressTarget(stepped);
      // A press that aimed at nothing leaves the cycle where it was: there is
      // no visit to record, and a grey face means the plugin does not trust
      // what it knows well enough to spend a step of the cycle on it.
      const next =
        target === null
          ? stepped
          : {
              ...stepped,
              visited: settle(new Set([...stepped.visited, target]), ordered(stepped)),
              aimedAt: target,
            };
      return {
        state: next,
        effects: [
          { type: "setTitle", socketPath: next.socketPath, nonce },
          ...(target === null
            ? []
            : ([{ type: "focusPane", socketPath: next.socketPath, paneId: target }] as const)),
          { type: "raise", nonce },
          { type: "clearTitle", socketPath: next.socketPath },
        ],
      };
    }

    case "focusResult": {
      // Both outcomes re-read the session, and neither retries. A focus that
      // landed may have consumed several `done` agents at once — focusing any
      // pane clears herdr's `seen` for every pane in that tab — and a focus
      // that failed means the snapshot the press was aimed with is already
      // wrong. Either way the only honest next move is to look again.
      //
      // A focus that failed also gives its visit back: the cycle records where
      // a press *took* the user, and this one took them nowhere. If the pane
      // died the next snapshot prunes it anyway; if it did not, the next press
      // tries it again.
      const visited =
        event.ok || state.aimedAt === null
          ? state.visited
          : new Set([...state.visited].filter((paneId) => paneId !== state.aimedAt));
      const next = { ...state, visited, aimedAt: null, at };
      return { state: next, effects: probe(next) };
    }

    case "tick": {
      // The heartbeat asks herdr for nothing. It only carries the time in, so
      // that a deadline can pass while the poll loop is wedged and silent.
      const next = { ...state, at };
      return { state: next, effects: scheduleTick(next) };
    }
  }
}

/**
 * The pane this press should focus, or `null` for "focus nothing and just
 * raise".
 *
 * The highest-priority pane the cycle has not shown yet — which is the
 * top-priority agent at the start of a cycle and diverges from it thereafter.
 * The visited set is settled on the way *in*, so it is never full here and this
 * cannot come back null for want of an unvisited pane.
 *
 * Null in exactly two cases, and they are the same case seen twice: there is
 * nothing waiting, or the face is grey. A grey tile is the plugin saying it
 * does not trust what it knows, and acting on distrusted data would make that
 * statement a lie — it would also be the one way the button could take the user
 * somewhere they did not ask to go.
 */
function pressTarget(state: CoreState): string | null {
  if (state.snapshot === null || stateColour(state) === "grey") return null;
  return ordered(state).find((agent) => !state.visited.has(agent.paneId))?.paneId ?? null;
}

/**
 * The marker written into herdr's `client_window_title` so the raise can find
 * the host terminal's window among every window on the machine.
 *
 * Human-legible on purpose: a client that dies mid-press strands it in the
 * title bar permanently, because `clear` then answers `no_foreground_client`,
 * and the user is the only one left who can remove it. So it names the tool
 * that wrote it and the session it was raising.
 *
 * The counter distinguishes *successive* presses — a title left over from an
 * earlier one is visibly not this one — and, being a count rather than a random
 * blob, it is something a test can assert. It does **not** make the nonce
 * unique across buttons: two tiles watching one session share herdr's single
 * `client_window_title`, so simultaneous presses collide there whatever this
 * says. Two tiles watching *different* sessions never collide, because the
 * session name is in the string.
 */
function nonceFor(state: CoreState): string {
  return `sd-herdr raise ${state.sessionName} #${state.presses}`;
}

/**
 * What the tile should show. Pure, and derived only from state — so the same
 * state always draws the same face.
 */
export function face(state: CoreState): FaceDescriptor {
  const colour = stateColour(state);

  // Grey is the one "cannot see anything" state, and is never all-clear. Its
  // plate reads `herdr` whatever the session is called, because grey is
  // deliberately *one* state: a plate that varied by cause would split on the
  // face what the colour joins, and the causes are not distinctions the user
  // can act on differently anyway.
  if (colour === "grey")
    return { stateColour: "grey", nameplate: "herdr", body: "", pips: [], pipOverflow: false };

  // The body names where the *next press* goes; the pips are everyone else
  // still waiting. Both are read off the same ordering the press cycle walks,
  // so the tile cannot promise a press the cycle would not make.
  const set = ordered(state);
  const target = pressTarget(state);
  const others = set.filter((agent) => agent.paneId !== target);

  return {
    stateColour: colour,
    // `default` is herdr's placeholder rather than a name the user chose, so
    // the slot buys product identity instead.
    nameplate: state.sessionName === DEFAULT_SESSION ? "herdr" : state.sessionName,
    body: state.snapshot === null ? "" : bodyFor(state.snapshot, set, target),
    pips: others.slice(0, PIP_CAP).map((agent) => TIER_COLOUR[agent.status]),
    pipOverflow: others.length > PIP_CAP,
  };
}

/**
 * The bar colour, and the whole of the grey policy.
 *
 * Every cause of "cannot see the session" collapses here into one colour: no
 * snapshot at all (an unreachable socket, a stopped session, or simply not
 * having asked yet), data that has aged past the deadline, and an attention set
 * that is nothing but `unknown` — which is the same statement about a session
 * the plugin can reach but cannot read.
 */
function stateColour(state: CoreState): StateColour {
  if (state.snapshot === null) return "grey";
  if (state.at - state.snapshotAt >= STALENESS_DEADLINE_MS) return "grey";

  // Settling: the one place the plugin deliberately overrides its own data.
  // During the gap the agents are absent from `agents[]` entirely, so the raw
  // snapshot would render *dark* — an all-clear about a session whose state is
  // simply not knowable yet. It ends on a fixed timer rather than on the data
  // agreeing, because after a stop/restart the data never will.
  if (state.at < state.settlingUntil) return "grey";

  // The attention set is already in priority order, so its head is the most
  // urgent thing in the session and its tier is the colour. Reading the colour
  // off the same ordering the press cycle uses keeps one table in charge of
  // both, rather than a second cascade that has to be kept in step with it.
  const head = attentionSet(state.snapshot.agents)[0];
  return head === undefined ? "dark" : TIER_COLOUR[head.status];
}
