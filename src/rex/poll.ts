/**
 * One Rex poll: `session.view`, then for every terminal block its program
 * status and its title, concurrently.
 *
 * Any failure rejects the whole snapshot. A destroyed session (`session_not_found`)
 * and a closed connection both end up where the core already puts a failed
 * snapshot: grey after the staleness deadline, with backoff in between.
 */
import type { Snapshot } from "../core/snapshot.js";
import { type Pollable, RexError } from "./client.js";
import { fromRex } from "./convert.js";
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

/** Take one snapshot of one Rex session. */
export async function pollSession(client: Pollable, sessionId: string): Promise<Snapshot> {
  // A tile with no session chosen has nothing to ask about; it stays grey.
  if (sessionId === "") throw new RexError("no_session", "no Rex session is configured");

  // Before the view: if the server restarts in between, the view is the newer
  // and the next poll's id shows the change, where the reverse would hide it.
  const instanceId = await client.instanceId();
  const view = decodeView(await client.request("session.view", { session_id: sessionId }));
  const reports = await Promise.all(
    terminalBlockIds(view).map(async (blockId): Promise<[string, BlockReport]> => {
      const args = { session_id: sessionId, block_id: blockId };
      const [status, title] = await Promise.all([
        client.request(PROGRAM_STATUS_METHOD, args),
        client.request(TITLE_METHOD, args),
      ]);
      return [blockId, decodeReport(status, title)];
    }),
  );
  return fromRex(view, new Map(reports), instanceId);
}
