/**
 * One Rex poll: the server's sessions, then each session's `session.view`, then
 * for every terminal block its program status and its title, concurrently.
 *
 * A tile speaks for the whole server, so every session is read and the views
 * are merged. Churn during the read is not a failure: a session destroyed
 * after the list (`session_not_found`) is skipped, and a block closed after the
 * view (`not_found`) is dropped, as if the read had been taken a moment later.
 * Otherwise one closing tab anywhere would fail every Rex tile's poll. Any
 * other failure rejects the whole snapshot, which the core already handles:
 * grey after the staleness deadline, with backoff in between.
 */
import type { Snapshot } from "../core/snapshot.js";
import { type Pollable, RexError } from "./client.js";
import { fromRex } from "./convert.js";
import { decodeSessions } from "./sessions.js";
import {
  type BlockReport,
  PROGRAM_STATUS_METHOD,
  type SessionView,
  type StatusRecord,
  TERMINAL_CREATOR,
  TITLE_METHOD,
} from "./view.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** Narrow a `session.view` result; one without a window list is still a view. */
export function decodeView(payload: unknown): SessionView {
  if (!isObject(payload)) throw new RexError("invalid_response", "session.view returned no object");
  return payload as SessionView;
}

/** Narrow a `program_status` and a `title` result to a block's report. */
export function decodeReport(status: unknown, title: unknown): BlockReport {
  if (!isObject(status) || !Array.isArray(status.records)) {
    throw new RexError("invalid_response", "program_status returned no records");
  }
  if (!isObject(title) || typeof title.title !== "string") {
    throw new RexError("invalid_response", "title returned no title");
  }
  return { records: status.records as StatusRecord[], title: title.title };
}

/** The terminal blocks of a view, from every layer of every window. */
export function terminalBlockIds(view: SessionView): string[] {
  return (view.windows ?? [])
    .flatMap((window) => window.layers ?? [])
    .flatMap((layer) => layer.blocks ?? [])
    .filter((block) => block.creator_name === TERMINAL_CREATOR)
    .map((block) => block.block_id);
}

const isCode = (err: unknown, code: string) => err instanceof RexError && err.code === code;

/** Gone since it was listed. */
class SessionGone extends Error {}

/** One block's report; null when the block closed since the view. */
async function readBlock(
  client: Pollable,
  sessionId: string,
  blockId: string,
): Promise<[string, BlockReport] | null> {
  const args = { session_id: sessionId, block_id: blockId };
  try {
    const [status, title] = await Promise.all([
      client.request(PROGRAM_STATUS_METHOD, args),
      client.request(TITLE_METHOD, args),
    ]);
    return [blockId, decodeReport(status, title)];
  } catch (err) {
    if (isCode(err, "not_found")) return null;
    if (isCode(err, "session_not_found")) throw new SessionGone();
    throw err;
  }
}

/** One session's view and its blocks' reports; null when the session is gone. */
async function readSession(
  client: Pollable,
  sessionId: string,
): Promise<{ view: SessionView; reports: [string, BlockReport][] } | null> {
  try {
    const view = decodeView(await client.request("session.view", { session_id: sessionId }));
    const reports = await Promise.all(
      terminalBlockIds(view).map((blockId) => readBlock(client, sessionId, blockId)),
    );
    return { view, reports: reports.filter((r) => r !== null) };
  } catch (err) {
    if (err instanceof SessionGone || isCode(err, "session_not_found")) return null;
    throw err;
  }
}

/** Take one snapshot of the whole Rex server. */
export async function pollServer(client: Pollable): Promise<Snapshot> {
  // Before the views: if the server restarts in between, the views are the
  // newer and the next poll's id shows the change, where the reverse would hide it.
  const instanceId = await client.instanceId();
  const sessions = decodeSessions(await client.request("session.list", {}));
  const read = await Promise.all(sessions.map((s) => readSession(client, s.session_id)));
  const live = read.filter((r) => r !== null);
  return fromRex(
    live.map((r) => r.view),
    new Map(live.flatMap((r) => r.reports)),
    instanceId,
  );
}
