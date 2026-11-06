/**
 * The Rex session picker: what the plugin sends the property inspector, and how
 * the live sessions become the options to show.
 *
 * The inspector is plain HTML with no build step, so it cannot import this; the
 * plugin turns the list into options and the inspector only renders them. The
 * setting stores the `session_id`, never the label: Rex relabels sessions by
 * itself and labels are not unique (`docs/research/rex-displayed-session.md` §3).
 */
import { type Requester, RexError } from "./client.js";

/** A session as `session.list` reports it. */
export interface RexSessionInfo {
  readonly session_id: string;
  readonly label: string;
}

/** The outcome of asking Rex for its sessions: the list, or why there is none. */
export type SessionList =
  | { readonly kind: "live"; readonly sessions: readonly RexSessionInfo[] }
  | { readonly kind: "down" };

/** One entry of the inspector's select. An empty `value` is "nothing chosen". */
export type SessionOption = {
  readonly value: string;
  readonly text: string;
  readonly disabled?: boolean;
};

/** Narrow a `session.list` result; entries without an id cannot be chosen and are dropped. */
export function decodeSessions(payload: unknown): RexSessionInfo[] {
  const list = (payload as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(list)) throw new RexError("invalid_response", "session.list returned no list");
  return list.flatMap((entry: { session_id?: unknown; label?: unknown } | null) =>
    typeof entry?.session_id === "string" && entry.session_id !== ""
      ? [
          {
            session_id: entry.session_id,
            label: typeof entry.label === "string" ? entry.label : "",
          },
        ]
      : [],
  );
}

/**
 * Ask Rex for its sessions. Any failure is "Rex is not running" as far as the
 * inspector is concerned: it cannot do anything different for a refused
 * connection than for a timeout, and the cause is logged by the caller.
 *
 * The connection is held only for the listing, so the inspector works with no
 * Rex tile on the deck and leaves nothing open behind it.
 */
export async function listSessions(
  client: Requester & { retain(): () => void },
  onError: (err: unknown) => void = () => {},
): Promise<SessionList> {
  const release = client.retain();
  try {
    return { kind: "live", sessions: decodeSessions(await client.request("session.list", {})) };
  } catch (err) {
    onError(err);
    return { kind: "down" };
  } finally {
    release();
  }
}

/**
 * The options to show, given what Rex reported and what is stored. The stored
 * id is always an option, so it stays selected: a session that is gone is shown
 * as missing and a server that is down does not forget the choice.
 */
export function sessionOptions(list: SessionList, stored: string): SessionOption[] {
  if (list.kind === "down") {
    return stored === ""
      ? [{ value: "", text: "Rex is not running", disabled: true }]
      : [{ value: stored, text: `${stored} (Rex is not running)` }];
  }

  // Labels can collide, so those that do carry their id to stay tellable apart.
  const counts = new Map<string, number>();
  for (const { label } of list.sessions) counts.set(label, (counts.get(label) ?? 0) + 1);
  const live: SessionOption[] = list.sessions.map(({ session_id, label }) => ({
    value: session_id,
    text:
      label === "" ? session_id : (counts.get(label) ?? 0) > 1 ? `${label} (${session_id})` : label,
  }));

  if (stored === "") {
    const none = list.sessions.length === 0 ? "No Rex sessions" : "Choose a session…";
    return [{ value: "", text: none, disabled: true }, ...live];
  }
  if (live.some((option) => option.value === stored)) return live;
  return [{ value: stored, text: `missing session (${stored})` }, ...live];
}

/** What the plugin sends the inspector, and the inspector's own request for it. */
export type SessionsMessage = {
  readonly event: "rexSessions";
  readonly options: SessionOption[];
  /** The value to select: the stored id, or `""` for none. */
  readonly selected: string;
};

export const LIST_REQUEST = "listRexSessions";

export function sessionsMessage(list: SessionList, stored: string): SessionsMessage {
  return { event: "rexSessions", options: sessionOptions(list, stored), selected: stored };
}
