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
    const id = `sd-herdr-${requestCounter}`;
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

/** Take one snapshot of the session behind a socket. */
export async function snapshot(socketPath: string): Promise<Snapshot> {
  return decodeSnapshot(await request(socketPath, "session.snapshot"));
}
