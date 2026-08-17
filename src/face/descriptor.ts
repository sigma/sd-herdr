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
export type StateColour = "red" | "amber" | "dark" | "grey";

/** What the tile renders for the current attention set. */
export interface FaceDescriptor {
  /** The state colour, carried by the nameplate. */
  readonly stateColour: StateColour;
  /** The nameplate's text: the session name, or `herdr` when it stands in. */
  readonly nameplate: string;
  /** The body line — where the next press will take the user. */
  readonly body: string;
}
