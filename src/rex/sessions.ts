/**
 * The sessions of the Rex server, as `session.list` reports them. A tile speaks
 * for the whole server, so both the poll and the press walk this list.
 */
import { RexError } from "./client.js";

/** A session as `session.list` reports it, narrowed to what the plugin reads. */
export interface RexSessionInfo {
  readonly session_id: string;
}

/** Narrow a `session.list` result; entries without an id cannot be asked about and are dropped. */
export function decodeSessions(payload: unknown): RexSessionInfo[] {
  const list = (payload as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(list)) throw new RexError("invalid_response", "session.list returned no list");
  return list.flatMap((entry: { session_id?: unknown } | null) =>
    typeof entry?.session_id === "string" && entry.session_id !== ""
      ? [{ session_id: entry.session_id }]
      : [],
  );
}
