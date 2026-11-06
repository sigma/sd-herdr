/**
 * The Rex control client: one long-lived WebSocket per server, shared by every
 * Rex tile.
 *
 * Unlike herdr's connect, write, read, hang up, this connection is held open,
 * so what herdr's client gets for free the Rex one has to do itself: correlate
 * responses to requests by id, notice a connection that went away, and decide
 * when to be connected at all. The wire contract is in
 * `docs/research/rex-control-api.md`.
 *
 * The edge (the socket) is thin and verified by hand against a live server; the
 * decoding and the correlation are pure and tested.
 */
import type { EventEmitter } from "node:events";
import { createConnection } from "node:net";

import WebSocket from "ws";

/** The API revision the plugin is written against, as both ends of the range. */
export const API_REVISION = 11;

/** How long a handshake or a request may take before it is given up on. */
const TIMEOUT_MS = 4000;

/** A Rex error, surfaced with its code intact. Branch on `code`, never on `message`. */
export class RexError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RexError";
  }
}

/** A message from the server, narrowed to what the client acts on. */
export type Incoming =
  | { readonly type: "welcome" }
  | {
      readonly type: "response";
      readonly id: string;
      readonly payload?: unknown;
      readonly error?: { readonly code: string; readonly message: string };
    }
  /** An event, or a type this client does not know: both are skipped. */
  | { readonly type: "other" };

/**
 * Decode one text frame. A frame that is not a JSON object is a protocol break
 * and rejects; an unknown `type` is not, because the protocol says to skip them.
 */
export function decodeMessage(text: string): Incoming {
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new RexError(
      "invalid_response",
      `Rex sent a frame that is not JSON: ${text.slice(0, 120)}`,
    );
  }
  if (envelope === null || typeof envelope !== "object") {
    throw new RexError("invalid_response", "Rex sent a frame that is not an object");
  }
  const message = envelope as {
    type?: unknown;
    id?: unknown;
    payload?: unknown;
    error?: { code?: unknown; message?: unknown } | null;
  };
  if (message.type === "welcome") return { type: "welcome" };
  if (message.type !== "response") return { type: "other" };
  if (typeof message.id !== "string") {
    throw new RexError("invalid_response", "Rex sent a response without an id");
  }
  if (message.error !== undefined && message.error !== null) {
    return {
      type: "response",
      id: message.id,
      error: {
        code: typeof message.error.code === "string" ? message.error.code : "unknown",
        message:
          typeof message.error.message === "string"
            ? message.error.message
            : "Rex returned an error",
      },
    };
  }
  return { type: "response", id: message.id, payload: message.payload };
}

interface Pending {
  resolve(payload: unknown): void;
  reject(err: Error): void;
}

/**
 * Matches responses to the requests that asked. Ids are strings, responses may
 * arrive out of order, and an id with nothing waiting on it (a response that
 * timed out, an id from a resumed client) is dropped.
 */
export class Correlator {
  private readonly waiting = new Map<string, Pending>();
  private counter = 0;

  /** How many requests are waiting for an answer. */
  get size(): number {
    return this.waiting.size;
  }

  /** A new request: its id, the frame to send, and the promise of its payload. */
  open(
    method: string,
    payload: object,
  ): { readonly id: string; readonly frame: string; readonly result: Promise<unknown> } {
    this.counter += 1;
    const id = `sd-mux-${this.counter}`;
    const result = new Promise<unknown>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
    });
    return { id, frame: JSON.stringify({ type: "request", id, method, payload }), result };
  }

  /** Settle the request a response answers. Anything else is skipped. */
  receive(message: Incoming): void {
    if (message.type !== "response") return;
    const pending = this.waiting.get(message.id);
    if (pending === undefined) return;
    this.waiting.delete(message.id);
    if (message.error !== undefined) {
      pending.reject(new RexError(message.error.code, message.error.message));
    } else {
      pending.resolve(message.payload);
    }
  }

  /** Give up on one request. */
  fail(id: string, err: Error): void {
    const pending = this.waiting.get(id);
    if (pending === undefined) return;
    this.waiting.delete(id);
    pending.reject(err);
  }

  /** The connection is gone: nothing in flight will be answered. */
  failAll(err: Error): void {
    for (const id of [...this.waiting.keys()]) this.fail(id, err);
  }
}

/** The hello, pinned to one revision at both ends so the shapes never move under the plugin. */
export function helloFrame(version: string): string {
  return JSON.stringify({
    type: "hello",
    api_revision: API_REVISION,
    api_min_revision: API_REVISION,
    client: { kind: "other", name: "sd-mux", version },
  });
}

/** What the client needs of a socket: the part of `ws` it uses, so a test can supply one. */
export interface ControlSocket extends EventEmitter {
  send(data: string): void;
  /** Sends a close frame. */
  close(): void;
}

/** Open the control WebSocket over the server's unix socket. */
export function openRexSocket(socketPath: string): ControlSocket {
  return new WebSocket("ws://localhost/api/control", "rex.control.v1", {
    createConnection: () => createConnection(socketPath),
  });
}

interface Connection {
  readonly socket: ControlSocket;
  readonly book: Correlator;
  /** Resolves, with the server's `instance_id`, once the handshake, attach and status read are done. */
  readonly ready: Promise<string>;
}

/** The part of the client the poll needs. */
export interface Requester {
  request(method: string, payload: object): Promise<unknown>;
}

/** What the poll needs: requests, and the lifetime marker its connection read. */
export interface Pollable extends Requester {
  /** The `instance_id` the current connection read when it opened. */
  instanceId(): Promise<string>;
}

/**
 * The shared connection.
 *
 * **Lifecycle.** The connection opens lazily, on the first request after a tile
 * has `retain`ed it, and closes with a close frame when the last tile releases
 * (the server otherwise holds a ghost client for 60 s). A request with nothing
 * retained rejects instead of reopening it, so a poll still in flight when the
 * last tile goes cannot bring it back. A connection that closes under a live
 * tile is not repaired here: every request in flight rejects, and the next poll
 * opens a new one, paced by the core's backoff. Each new connection reads the
 * server's `instance_id`, the lifetime marker (`instanceId`).
 *
 * Events are neither buffered nor applied; the attach is `event_scope:
 * "session"` and the client polls.
 */
export class RexControl implements Pollable {
  private conn: Connection | null = null;
  private retained = 0;

  constructor(
    private readonly open: () => ControlSocket,
    private readonly version: () => string,
    private readonly timeoutMs: number = TIMEOUT_MS,
  ) {}

  /** A Rex tile is visible. The returned function says it no longer is. */
  retain(): () => void {
    this.retained += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.retained -= 1;
      if (this.retained === 0) this.shutdown();
    };
  }

  /** Whether a connection exists, connecting or connected. */
  get connected(): boolean {
    return this.conn !== null;
  }

  async request(method: string, payload: object): Promise<unknown> {
    if (this.retained === 0) throw new RexError("closed", "no Rex tile is visible");
    const conn = this.conn ?? this.connect();
    await conn.ready;
    return this.send(conn, method, payload);
  }

  async instanceId(): Promise<string> {
    if (this.retained === 0) throw new RexError("closed", "no Rex tile is visible");
    return (this.conn ?? this.connect()).ready;
  }

  private send(conn: Connection, method: string, payload: object): Promise<unknown> {
    const { id, frame, result } = conn.book.open(method, payload);
    const timer = setTimeout(
      () => conn.book.fail(id, new RexError("timeout", `Rex did not answer ${method} in time`)),
      this.timeoutMs,
    );
    result.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
    try {
      conn.socket.send(frame);
    } catch (err) {
      conn.book.fail(id, err instanceof Error ? err : new Error(String(err)));
    }
    return result;
  }

  private connect(): Connection {
    const socket = this.open();
    const book = new Correlator();
    let gone: (err: Error) => void = () => {};
    const ready = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => gone(new RexError("timeout", "Rex did not complete the handshake in time")),
        this.timeoutMs,
      );
      let over = false;
      gone = (err) => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        reject(err);
        if (this.conn === conn) this.conn = null;
        book.failAll(err);
        try {
          socket.close();
        } catch {
          // Already closing: the point was to make sure it is.
        }
      };

      let welcomed = false;
      socket.on("open", () => socket.send(helloFrame(this.version())));
      socket.on("message", (data: { toString(): string }) => {
        let message: Incoming;
        try {
          message = decodeMessage(data.toString());
        } catch (err) {
          gone(err as Error);
          return;
        }
        if (welcomed) {
          book.receive(message);
          return;
        }
        if (message.type !== "welcome") {
          gone(new RexError("invalid_response", "Rex answered the hello with something else"));
          return;
        }
        welcomed = true;
        // A session can only be named once attached, and this attaches to all
        // of them, which is enough for `session.view` and for block methods.
        // The status is read on every connect, never cached across them: a
        // restart always drops the connection first, so a new connection is
        // where a new `instance_id` shows.
        this.send(conn, "session.attach_all", { event_scope: "session" })
          .then(() => this.send(conn, "server.status", {}))
          .then((status) => {
            const id = (status as { instance_id?: unknown } | null)?.instance_id;
            if (typeof id !== "string" || id === "") {
              throw new RexError("invalid_response", "server.status returned no instance_id");
            }
            clearTimeout(timer);
            resolve(id);
          })
          .catch(gone);
      });
      socket.on("error", (err: Error) => gone(err));
      socket.on("close", () => gone(new RexError("closed", "Rex closed the connection")));
    });
    // Whoever asked for the connection awaits it; this keeps a failure nobody
    // is awaiting any more from surfacing as unhandled.
    ready.catch(() => {});
    const conn: Connection = { socket, book, ready };
    this.conn = conn;
    return conn;
  }

  private shutdown(): void {
    const conn = this.conn;
    if (conn === null) return;
    this.conn = null;
    conn.book.failAll(new RexError("closed", "no Rex tile is visible"));
    conn.socket.close();
  }
}
