/**
 * One poll loop per session, however many buttons are pointed at it.
 *
 * A button speaks for exactly one session — that is what keeps the face's
 * single colour meaningful — so watching two sessions means two buttons. But
 * two buttons on the *same* session must not cost two snapshots: a snapshot is
 * ~110 ms and ~15 KB, and duplicating it scales badly with the number of
 * buttons and terribly with a Stream Deck full of them.
 *
 * So the loop is keyed on the session key (an opaque string; herdr's is the
 * socket path), and the buttons are subscribers to it. They share the cycle as
 * well as the poll, which is the honest reading of
 * a visited set that belongs to a session rather than to a key: two tiles on
 * one session are two views of one walk through it.
 *
 * What stays per-button is the raise — it ends at a Stream Deck key, with that
 * key's own host-app setting and its own alert — so the press that provoked one
 * is remembered and the raise is handed back to it.
 */
import type { FaceDescriptor } from "../face/descriptor.js";
import { type Adapters, Runner } from "./runner.js";

/** Everything the loop needs that is not one button's business. */
export type SharedAdapters = Omit<Adapters, "paint" | "raise">;

/** One button's end of a shared session. */
export interface Subscriber {
  /** Draw a face on this button's key. */
  paint(face: FaceDescriptor): void | Promise<void>;
  /** Raise for a press this button made, with this button's settings. */
  raise(nonce: string): Promise<void>;
}

/** A button's membership of one session, for as long as it is pointed at it. */
export interface Membership {
  /** This button was pressed. */
  press(): void;
  /** This button is gone, or has been repointed at another session. */
  leave(): void;
}

interface Session {
  runner: Runner;
  readonly subscribers: Set<Subscriber>;
  /**
   * Presses awaiting their raise, oldest first. A queue rather than a "last
   * presser" field because the raise is one effect of a four-effect press, and
   * a second button can press while the first press is still draining.
   */
  readonly pressers: Subscriber[];
  /** The last face drawn, so a button joining a running loop is not blank. */
  last: FaceDescriptor | null;
}

export class SessionHub {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly adapters: SharedAdapters) {}

  /** How many poll loops are running. The thing "one loop per session key" is a claim about. */
  get loops(): number {
    return this.sessions.size;
  }

  /**
   * Point a button at a session, starting that session's loop if it is the
   * first one there.
   */
  join(sessionName: string, sessionKey: string, subscriber: Subscriber): Membership {
    const existing = this.sessions.get(sessionKey);
    const session = existing ?? this.open(sessionName, sessionKey);
    session.subscribers.add(subscriber);

    if (existing === undefined) {
      // First one in: the loop starts, and its first paint reaches this
      // subscriber like any other.
      session.runner.appeared();
    } else if (session.last !== null) {
      // Joining a loop already running: draw what it last said, rather than
      // leaving the key blank until something changes.
      void subscriber.paint(session.last);
    }

    return {
      press: () => {
        session.pressers.push(subscriber);
        session.runner.pressed();
      },
      leave: () => this.leave(sessionKey, subscriber),
    };
  }

  private leave(sessionKey: string, subscriber: Subscriber): void {
    const session = this.sessions.get(sessionKey);
    if (session === undefined) return;
    session.subscribers.delete(subscriber);
    // A press whose raise never came back must not be handed to some other
    // button later.
    for (let i = session.pressers.length - 1; i >= 0; i -= 1) {
      if (session.pressers[i] === subscriber) session.pressers.splice(i, 1);
    }
    if (session.subscribers.size > 0) return;

    // Nobody is looking any more: the loop stops, and the cycle goes with it.
    // A session nobody is pointed at costs nothing, and the visited set is a
    // record of one sitting at the keyboard — reopening it later should start
    // at the top rather than mid-walk.
    session.runner.disappeared();
    this.sessions.delete(sessionKey);
  }

  private open(sessionName: string, sessionKey: string): Session {
    const session: Session = {
      // Assigned immediately below; the adapters close over `session`, and
      // nothing calls them before the constructor returns.
      runner: undefined as unknown as Runner,
      subscribers: new Set(),
      pressers: [],
      last: null,
    };
    session.runner = new Runner(sessionName, sessionKey, {
      ...this.adapters,
      paint: (face) => {
        session.last = face;
        for (const subscriber of session.subscribers) void subscriber.paint(face);
      },
      // Back to whoever pressed. Falling back to any subscriber rather than
      // dropping the raise: the window still has a nonce written into its
      // title, and the press it belongs to still asked to be taken there.
      raise: (nonce) => {
        const presser = session.pressers.shift() ?? [...session.subscribers][0];
        return presser?.raise(nonce) ?? Promise.resolve();
      },
    });
    this.sessions.set(sessionKey, session);
    return session;
  }
}
