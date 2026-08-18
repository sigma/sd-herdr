/**
 * The other side of the seam: the thing that obeys.
 *
 * The core says *what* should happen — resolve a socket, take a snapshot, poll
 * again in a second — and the runner does it, feeding each outcome back in as a
 * timestamped event. It holds no policy of its own: every branch here is about
 * plumbing (which adapter answers an effect, when a timer is cancelled), never
 * about what the tile should say.
 */
import type { FaceDescriptor } from "../face/descriptor.js";
import type { Snapshot } from "../herdr/snapshot.js";
import { type CoreEvent, type CoreState, type Effect, face, initial, reduce } from "./core.js";

/** A cancellable timer, so a test can fire one instead of waiting for it. */
export interface Timer {
  cancel(): void;
}

/** Everything the runner needs from the world, so a test can supply all of it. */
export interface Adapters {
  /** One snapshot, or a rejection. */
  snapshot(socketPath: string): Promise<Snapshot>;
  /**
   * Ask the server what it is. The result goes nowhere the core can see it —
   * this is a record for the log, not an input to the face — so a failed ping
   * changes nothing but what the log says.
   */
  ping(socketPath: string): Promise<void>;
  /** Mark the session's host terminal window, so the raise has something to aim at. */
  setTitle(socketPath: string, nonce: string): Promise<void>;
  /** Put the terminal's own title back. */
  clearTitle(socketPath: string): Promise<void>;
  /** Focus one pane — workspace, tab and pane in a single call. Rejects if it is gone. */
  focusPane(socketPath: string, paneId: string): Promise<void>;
  /** Bring the marked window forward, by whichever rung of the ladder answers. */
  raise(nonce: string): Promise<void>;
  /** Draw a face on the key. */
  paint(descriptor: FaceDescriptor): Promise<void> | void;
  /** The clock — read *here*, never in the core, and stamped onto every event. */
  now(): number;
  /** Schedule a callback. */
  schedule(ms: number, fn: () => void): Timer;
  /** Say that something went wrong. The tile is an image on a key; this is the record. */
  report(message: string): void;
}

/**
 * One button's worth of running plugin.
 *
 * Events are handled one at a time and effects dispatched as they come back, so
 * the poll chain is a loop of snapshot → pollAfter → pollDue → snapshot with
 * only one request ever in flight.
 */
export class Runner {
  private state: CoreState;
  private pending: Timer | null = null;
  /**
   * The heartbeat, held apart from the poll timer on purpose: a wedged poll
   * leaves `pending` empty forever, and it is precisely then that the core
   * still needs the time handed to it.
   */
  private beat: Timer | null = null;
  private painted: string | null = null;
  /**
   * Effects waiting their turn. The press is four adapter calls whose *order*
   * is the contract — nonce, focus, raise, clear — so effects are performed one
   * at a time rather than fired off together.
   */
  private queue: Effect[] = [];
  private draining = false;

  constructor(
    sessionName: string,
    socketPath: string,
    private readonly adapters: Adapters,
  ) {
    this.state = initial(sessionName, socketPath);
  }

  /** The button came on screen. */
  appeared(): void {
    this.dispatch({ type: "appeared", at: this.adapters.now() });
  }

  /**
   * The button went away. The pending poll is cancelled rather than left to
   * fire into a core that would ignore it — an invisible button should cost
   * nothing at all.
   */
  disappeared(): void {
    this.cancelPending();
    this.beat?.cancel();
    this.beat = null;
    this.dispatch({ type: "disappeared", at: this.adapters.now() });
  }

  /** The user pressed the key. */
  pressed(): void {
    this.dispatch({ type: "pressed", at: this.adapters.now() });
  }

  private dispatch(event: CoreEvent): void {
    const step = reduce(this.state, event);
    this.state = step.state;
    this.repaint();
    this.queue.push(...step.effects);
    void this.drain();
  }

  /**
   * Perform the queued effects in order, waiting for each to finish before
   * starting the next. Re-entrant by design: an adapter's result is dispatched
   * straight back in, and the effects that come of it join the same queue.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let effect = this.queue.shift(); effect !== undefined; effect = this.queue.shift()) {
        await this.perform(effect);
      }
    } finally {
      this.draining = false;
    }
  }

  /** Draw only when the face actually changed — a poll a second is not a redraw a second. */
  private repaint(): void {
    const descriptor = face(this.state);
    const key = JSON.stringify(descriptor);
    if (key === this.painted) return;
    this.painted = key;
    void this.adapters.paint(descriptor);
  }

  private cancelPending(): void {
    this.pending?.cancel();
    this.pending = null;
  }

  private async perform(effect: Effect): Promise<void> {
    switch (effect.type) {
      case "snapshot":
        // The one effect nothing waits for. A snapshot that never comes back
        // must not take the heartbeat down with it — the staleness deadline
        // exists precisely to notice that case, and it can only notice while
        // ticks are still being scheduled behind it.
        void this.adapters
          .snapshot(effect.socketPath)
          .then((snapshot) =>
            this.dispatch({ type: "snapshotTaken", at: this.adapters.now(), snapshot }),
          )
          .catch(() => this.dispatch({ type: "snapshotFailed", at: this.adapters.now() }));
        return;

      case "ping":
        // Nothing waits on the answer, and nothing branches on it: a ping that
        // fails is a socket that is down, which the very next snapshot says
        // more usefully.
        await this.attempt("ping", () => this.adapters.ping(effect.socketPath));
        return;

      case "pollAfter":
        this.cancelPending();
        this.pending = this.adapters.schedule(effect.ms, () => {
          this.pending = null;
          this.dispatch({ type: "pollDue", at: this.adapters.now() });
        });
        return;

      case "tickAfter":
        this.beat?.cancel();
        this.beat = this.adapters.schedule(effect.ms, () => {
          this.beat = null;
          this.dispatch({ type: "tick", at: this.adapters.now() });
        });
        return;

      case "setTitle":
        await this.attempt("setTitle", () =>
          this.adapters.setTitle(effect.socketPath, effect.nonce),
        );
        return;

      case "focusPane":
        // Every way this can fail takes the same shape as `pane_not_found`:
        // the snapshot the press was aimed with is stale. The core is told so
        // and re-reads it; nothing here retries.
        await this.adapters
          .focusPane(effect.socketPath, effect.paneId)
          .then(() => this.dispatch({ type: "focusResult", at: this.adapters.now(), ok: true }))
          .catch(() => this.dispatch({ type: "focusResult", at: this.adapters.now(), ok: false }));
        return;

      case "raise":
        await this.attempt("raise", () => this.adapters.raise(effect.nonce));
        return;

      case "clearTitle":
        await this.attempt("clearTitle", () => this.adapters.clearTitle(effect.socketPath));
        return;
    }
  }

  /**
   * Run one adapter and swallow whatever it throws.
   *
   * The press is a sequence whose *tail* matters most: a nonce left behind is
   * the one failure a human has to clean up by hand, in their title bar. So no
   * step of it is allowed to abort the steps after it.
   */
  private async attempt(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.adapters.report(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
