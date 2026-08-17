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
  /** Draw a face on the key. */
  paint(descriptor: FaceDescriptor): Promise<void> | void;
  /** The clock — read *here*, never in the core, and stamped onto every event. */
  now(): number;
  /** Schedule a callback. */
  schedule(ms: number, fn: () => void): Timer;
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
  private painted: string | null = null;

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
    this.dispatch({ type: "disappeared", at: this.adapters.now() });
  }

  private dispatch(event: CoreEvent): void {
    const step = reduce(this.state, event);
    this.state = step.state;
    this.repaint();
    for (const effect of step.effects) this.perform(effect);
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

  private perform(effect: Effect): void {
    switch (effect.type) {
      case "snapshot":
        void this.adapters
          .snapshot(effect.socketPath)
          .then((snapshot) =>
            this.dispatch({ type: "snapshotTaken", at: this.adapters.now(), snapshot }),
          )
          .catch(() => this.dispatch({ type: "snapshotFailed", at: this.adapters.now() }));
        return;

      case "pollAfter":
        this.cancelPending();
        this.pending = this.adapters.schedule(effect.ms, () => {
          this.pending = null;
          this.dispatch({ type: "pollDue", at: this.adapters.now() });
        });
        return;
    }
  }
}
