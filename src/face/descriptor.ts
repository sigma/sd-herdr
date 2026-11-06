/**
 * The **face** descriptor: what the tile shows, as data rather than pixels.
 *
 * The spec's architecture is one pure core producing `face(state) ->
 * FaceDescriptor`, with descriptor→SVG a separate trivial renderer at the edge.
 * This is the descriptor half in embryo — the shape exists and the renderer
 * draws it, but nothing computes one yet: the skeleton hands the action a
 * hard-coded value. The core that derives it from a snapshot lands later.
 */

/**
 * The tile's state colour. `grey` is deliberately a *single* state covering
 * every "cannot see" cause — unreachable socket, stopped session, stale
 * snapshot, settling, an `unknown`-only attention set — and is never rendered as
 * all-clear.
 */
export type StateColour = "red" | "green" | "amber" | "dark" | "grey";

/**
 * A pip's colour: the tier of one agent still waiting. A strict subset of the
 * state colours, because a pip speaks for one agent and `dark` is a statement
 * about the whole session.
 */
export type PipColour = "red" | "green" | "amber" | "grey";

/** How many pips the row draws before it stops counting and says `…` instead. */
export const PIP_CAP = 4;

/** What the tile renders for the current attention set. */
export interface FaceDescriptor {
  /** The state colour, carried by the nameplate. */
  readonly stateColour: StateColour;
  /** The nameplate's text: the session's label or name, or the backend's name when it stands in. */
  readonly nameplate: string;
  /** The body line — where the next press will take the user. */
  readonly body: string;
  /**
   * The **other** waiters, tier-coloured, in priority order and already capped
   * at `PIP_CAP`. The agent the body names never gets a pip, so the body and
   * the pips never restate each other.
   *
   * There is no hollow-vs-filled axis, deliberately: a ring marking the
   * target's same-tab sibling was considered and rejected, because it would
   * warn about a cost the user cannot avoid.
   */
  readonly pips: readonly PipColour[];
  /** Whether more waiters were cut than the row can show — drawn as a trailing `…`. */
  readonly pipOverflow: boolean;
}
