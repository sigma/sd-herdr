/**
 * What the core needs to know about the multiplexer a tile speaks to, beyond
 * the snapshot: three constants and a naming rule. Everything else a backend
 * does (snapshot, ping, focus, raise) is an adapter the runner calls.
 */
export interface Backend {
  /** The grey face's plate, whatever the session is called. */
  readonly name: string;
  /**
   * Whether a press writes its nonce into the host window's title before
   * raising. With `false` the core emits no `setTitle` or `clearTitle`.
   */
  readonly marksWindow: boolean;
  /**
   * How long the face is held grey after a detected restart. With `0` a restart
   * resets the visited set and nothing more.
   */
  readonly settleMs: number;
  /** The plate for a live session: the name to show for the one the user configured. */
  plateFor(sessionName: string): string;
}
