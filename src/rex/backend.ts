import type { Backend } from "../core/backend.js";

/**
 * Rex, as the core sees it.
 *
 * Nothing marks a window on Rex: a press is three calls to the server and the
 * app, with no window-title nonce. Nothing settles after a restart either: a
 * restart kills every agent and nothing comes back, so a dark tile afterwards is
 * the truth (`docs/research/rex-server-restart.md`).
 *
 * A tile speaks for the whole local server, every session in it, so the
 * session key is the server's socket path and the plate is just `rex`.
 */
export const REX: Backend = {
  name: "rex",
  marksWindow: false,
  settleMs: 0,
  plateFor: () => "rex",
};
