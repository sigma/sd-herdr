import type { Backend } from "../core/backend.js";
import { DEFAULT_SESSION } from "./session.js";

/**
 * herdr, as the core sees it.
 *
 * `settleMs` is sized for the slower of the two restart shapes, because they
 * are indistinguishable at the moment they happen: a live handoff brings agents
 * back at ~0.4 s but correct statuses only at ~3.74 s, since re-detected state
 * is seeded `Idle` under a 3 s startup grace window
 * (`docs/research/herdr-detected-agent-restart.md`). A stop/restart resolves to
 * nothing at all, and 4 s of grey before an honest dark tile costs nothing.
 * It is deliberately its own number, not the staleness deadline: they answer
 * different questions.
 */
export const HERDR: Backend = {
  name: "herdr",
  marksWindow: true,
  settleMs: 4000,
  // `default` is herdr's placeholder rather than a name the user chose, so the
  // slot buys product identity instead.
  plateFor: (sessionName) => (sessionName === DEFAULT_SESSION ? "herdr" : sessionName),
};
