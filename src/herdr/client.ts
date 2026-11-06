/**
 * The herdr socket client.
 *
 * Newline-delimited JSON over a unix socket, **one request per connection**:
 * the server reads exactly one line, answers it, and hangs up. It never loops
 * back for a second request, so there is no pipelining and no connection to
 * keep — every snapshot is its own connect → write → read one line → close.
 *
 * Authorisation is filesystem-only (the socket is mode 0600), so there is no
 * handshake, no auth and no version negotiation to perform.
 */
import { createConnection } from "node:net";

import type { Snapshot } from "./snapshot.js";

/** How long to wait for the whole connect-write-read cycle. */
const REQUEST_TIMEOUT_MS = 4000;

/** A herdr error response, surfaced with its code intact. */
export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HerdrError";
  }
}

/**
 * Pull the result out of one response line.
 *
 * Kept separate from the socket so the wire contract can be tested without one.
 * The `id` is deliberately not checked: one request per connection means the
 * only line that can arrive is the answer to it, and herdr echoes `""` on a
 * parse failure and `"<id>:sub:<n>:probe"` on a subscription error rather than
 * the id it was sent.
 */
export function decodeResponse(line: string): unknown {
  let envelope: unknown;
  try {
    envelope = JSON.parse(line);
  } catch {
    throw new HerdrError(
      "invalid_response",
      `herdr sent a line that is not JSON: ${line.slice(0, 120)}`,
    );
  }
  const { error, result } = (envelope ?? {}) as {
    error?: { code?: unknown; message?: unknown };
    result?: unknown;
  };
  if (error !== undefined) {
    throw new HerdrError(
      typeof error.code === "string" ? error.code : "unknown",
      typeof error.message === "string" ? error.message : "herdr returned an error",
    );
  }
  if (result === undefined)
    throw new HerdrError("invalid_response", "herdr response had no result");
  return result;
}

/** Narrow a `session.snapshot` result to the snapshot itself. */
export function decodeSnapshot(line: string): Snapshot {
  const result = decodeResponse(line) as { snapshot?: unknown };
  const snapshot = result.snapshot;
  if (snapshot === null || typeof snapshot !== "object") {
    throw new HerdrError("invalid_response", "session.snapshot result carried no snapshot");
  }
  return snapshot as Snapshot;
}

/** What a `ping` says about the server on the other end of the socket. */
export interface Pong {
  readonly version: string;
  readonly protocol: number;
}

/**
 * Narrow a `ping` result to the two fields worth keeping.
 *
 * A pong without them is a decoding failure rather than a partial answer: this
 * response exists to say *which herdr this is*, and a version-less one has not
 * said it.
 */
export function decodePong(line: string): Pong {
  const result = decodeResponse(line) as { version?: unknown; protocol?: unknown };
  if (typeof result.version !== "string" || typeof result.protocol !== "number") {
    throw new HerdrError("invalid_response", "ping answered without a version and protocol");
  }
  return { version: result.version, protocol: result.protocol };
}

/**
 * What herdr did with a window title. `no_foreground_client` is the one that
 * matters: a normal, successful response saying the call did nothing, because
 * no terminal is attached to the session. Branch on the reason, never on the
 * absence of an error.
 */
export type TitleReason = "set" | "cleared" | "no_foreground_client";

const TITLE_REASONS: readonly string[] = ["set", "cleared", "no_foreground_client"];

/**
 * Narrow a `client.window_title.*` result to what it did.
 *
 * A reason herdr did not send, or one this build does not know, is a decoding
 * failure rather than a value: reading it as `no_foreground_client` would
 * report "there is no terminal attached" about a call that may well have
 * worked, which is the one thing this response exists to tell the caller.
 */
export function decodeTitleReason(line: string): TitleReason {
  const { reason } = decodeResponse(line) as { reason?: unknown };
  if (typeof reason !== "string" || !TITLE_REASONS.includes(reason)) {
    throw new HerdrError("invalid_response", `herdr answered with an unknown reason: ${reason}`);
  }
  return reason as TitleReason;
}

let requestCounter = 0;

/**
 * Send one request and read the one line that answers it.
 *
 * Rejects on transport failure — `ENOENT` when the session is gone and its
 * socket file with it, `ECONNREFUSED` when the file outlived its server. Both
 * mean the same thing to the caller: the session is not visible.
 */
function request(socketPath: string, method: string, params: object = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    requestCounter += 1;
    const id = `sd-mux-${requestCounter}`;
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new HerdrError("timeout", "herdr did not answer in time"))),
      REQUEST_TIMEOUT_MS,
    );

    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        const line = buffer.slice(0, newline);
        finish(() => resolve(line));
      }
    });
    socket.on("error", (err) => finish(() => reject(err)));
    // A clean EOF before any line is a connection lost, never an empty answer.
    socket.on("close", () =>
      finish(() => reject(new HerdrError("closed", "herdr closed without responding"))),
    );
  });
}

/**
 * Ask the server what it is: version, protocol number, capability flags.
 *
 * Version discovery is an ordinary request rather than a handshake, so this is
 * issued only when the answer can have changed — on startup and on a detected
 * server lifetime boundary — and never on the poll path, which already proves
 * the socket answers.
 */
export async function ping(socketPath: string): Promise<Pong> {
  return decodePong(await request(socketPath, "ping"));
}

/** Take one snapshot of the session behind a socket. */
export async function snapshot(socketPath: string): Promise<Snapshot> {
  return decodeSnapshot(await request(socketPath, "session.snapshot"));
}

/**
 * Mark the session's host terminal window with a title, so that a window
 * manager can be asked to raise *that* window rather than the application.
 *
 * herdr never re-asserts a title over a set nonce — verified across pane
 * split and focus, cwd change, status change, tab and workspace create and
 * focus, and 20 s of idle — so set → raise → clear has no title race.
 */
export async function setWindowTitle(socketPath: string, title: string): Promise<TitleReason> {
  return decodeTitleReason(await request(socketPath, "client.window_title.set", { title }));
}

/**
 * Put the terminal's own title back. There is no "set it to empty": herdr
 * rejects an empty title, and this is the method that undoes a set.
 */
export async function clearWindowTitle(socketPath: string): Promise<TitleReason> {
  return decodeTitleReason(await request(socketPath, "client.window_title.clear"));
}

/**
 * Focus one pane — which switches herdr's workspace, tab and pane in a single
 * call, so there is nothing to chain.
 *
 * Rejects with `pane_not_found` when the pane died between the snapshot and the
 * press; herdr answers the same way for a malformed id and one that never
 * existed, and the caller's reaction is the same in all three cases.
 */
export async function focusPane(socketPath: string, paneId: string): Promise<void> {
  decodeResponse(await request(socketPath, "pane.focus", { pane_id: paneId }));
}
