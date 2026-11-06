import type { Backend } from "../core/backend.js";

/**
 * Rex, as the core sees it.
 *
 * Nothing marks a window on Rex: a press is three calls to the server and the
 * app, with no window-title nonce. Nothing settles after a restart either: a
 * restart kills every agent and nothing comes back, so a dark tile afterwards is
 * the truth (`docs/research/rex-server-restart.md`).
 *
 * The session key is the `session_id` and nothing else, because there is one
 * local server. The plate is the session's label, which the snapshot carries
 * because Rex relabels sessions by itself; `plateFor` is only the fallback for a
 * view that has none.
 */
export const REX: Backend = {
  name: "rex",
  marksWindow: false,
  settleMs: 0,
  plateFor: () => "rex",
};
