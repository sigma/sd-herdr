/**
 * Rung 2 of the raise ladder: ask the terminal application itself to bring the
 * window carrying the nonce forward.
 *
 * There is **no single generic incantation**. The Standard Suite's writable
 * `window.index` is not portable — Terminal.app has it, Ghostty does not — and
 * `System Events`' `AXRaise` is the Accessibility wall this design refuses to
 * depend on. So the rung is a table keyed on bundle id, and its **default
 * branch is a real case rather than a safety net**: WezTerm answers `-1728` to
 * every window query and cannot be window-targeted at all, which is the whole
 * reason rung 1 exists.
 *
 * Errors are classified by **numeric AppleEvent code, never by message text**.
 * The messages are localised and app-authored; the codes are the platform's,
 * and `docs/research/macos-automation-prompt.md` measured what they mean.
 */

/**
 * How the rung went.
 *
 * `denied` and `ungranted` are kept apart from the rest, and from each other,
 * despite all three provoking the same fall-through. `denied` is the user
 * having pressed *Don't Allow*: every later attempt returns the same code and
 * macOS never re-prompts, so it is the one thing here that can only be fixed in
 * System Settings. `ungranted` is "never asked", which the *next* press may
 * well resolve — saying "macOS will not ask again" about it would send the user
 * to fix something that is not broken.
 */
export type AppleScriptOutcome =
  | "raised"
  | "unsupported"
  | "missed"
  | "denied"
  | "ungranted"
  | "unavailable";

/** One osascript run, reduced to what the classification reads. */
export interface Osascript {
  run(script: string): Promise<{ code: number; stderr: string }>;
  log(message: string): void;
}

/**
 * The AppleEvent codes this rung branches on, from
 * `docs/research/macos-automation-prompt.md` §2 and §7 and
 * `docs/research/terminal-window-discovery.md` §3.2.
 */
const ERROR = {
  /** errAEEventNotPermitted — the user pressed *Don't Allow*, once, forever. */
  notPermitted: -1743,
  /** errAEEventWouldRequireUserConsent — never asked, and we did not ask now. */
  wouldRequireConsent: -1744,
  /** Can't get <object> — the window query is unsupported, or nothing matched. */
  noSuchObject: -1728,
  /** Can't get application process … — the target is not a GUI application. */
  notAGuiApp: -1719,
  /** procNotFound — the application is not running. */
  notRunning: -600,
} as const;

/**
 * The per-bundle-id table. Data, not code: an unknown terminal degrades to the
 * next rung rather than being special-cased, and adding one is one line.
 *
 * Each entry raises **the window whose title carries the nonce**, never the
 * front window — an app-level raise is rung 3's job and is a different promise.
 */
const TABLE: Record<string, (nonce: string) => string> = {
  // Ghostty declares no `index` on its windows and ships a bespoke command
  // instead. Verified: `activate window` both raises the window and brings the
  // app frontmost, with an Automation grant alone.
  "com.mitchellh.ghostty": (nonce) =>
    `tell application id "com.mitchellh.ghostty" to activate window (first window whose name contains ${quote(nonce)})`,
  // Terminal.app's dictionary declares `window.index`, "ordered front to back",
  // read/write — so front-most is index 1, and the app still needs activating.
  "com.apple.Terminal": (nonce) =>
    `tell application id "com.apple.Terminal"\nset index of (first window whose name contains ${quote(nonce)}) to 1\nactivate\nend tell`,
  // iTerm2 exposes `select` on a window, which raises it within the app.
  "com.googlecode.iterm2": (nonce) =>
    `tell application id "com.googlecode.iterm2"\nselect (first window whose name contains ${quote(nonce)})\nactivate\nend tell`,
};

/** The script that raises this app's nonce-carrying window, if there is one. */
export function scriptFor(bundleId: string, nonce: string): string | null {
  return TABLE[bundleId]?.(nonce) ?? null;
}

/** The bundle ids the table can window-target. Exported for the tests and #28. */
export const SCRIPTABLE_BUNDLE_IDS = Object.keys(TABLE);

/**
 * An AppleScript string literal. AppleScript understands only `\"` and `\\`
 * inside one, and the nonce carries a session name the user chose, so both are
 * reachable input.
 */
function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * The AppleEvent code in an `osascript` failure, or null when it carries none.
 *
 * `osascript` prints `execution error: <app> got an error: <message>. (-1728)`,
 * so the code is the last parenthesised integer on stderr. Read positionally
 * rather than by matching the sentence around it: that sentence is localised
 * and app-authored, and the number is the only part of it the platform owns.
 */
export function errorCode(stderr: string): number | null {
  const close = stderr.lastIndexOf(")");
  if (close < 0) return null;
  const open = stderr.lastIndexOf("(", close);
  if (open < 0) return null;
  const inner = stderr.slice(open + 1, close).trim();
  if (inner.length === 0) return null;
  for (const [index, character] of [...inner].entries()) {
    const digit = character >= "0" && character <= "9";
    const sign = index === 0 && (character === "-" || character === "+");
    if (!digit && !sign) return null;
  }
  const code = Number(inner);
  return Number.isInteger(code) ? code : null;
}

/** What a failing run means, by code alone. */
function classify(code: number | null): AppleScriptOutcome {
  switch (code) {
    case ERROR.notPermitted:
      return "denied";
    case ERROR.wouldRequireConsent:
      return "ungranted";
    case ERROR.noSuchObject:
      return "unsupported";
    case ERROR.notAGuiApp:
    case ERROR.notRunning:
      return "unavailable";
    default:
      return "missed";
  }
}

/**
 * Raise the nonce-carrying window of `bundleId`, as far as rung 2 can.
 *
 * A `denied` result is reported and then dropped: there is nothing to retry —
 * the grant is Stream-Deck-wide and macOS will not ask again — so the only
 * thing left to do about it is tell the user where to go, which is #28's README.
 */
export async function raiseByAppleScript(
  bundleId: string,
  nonce: string,
  osascript: Osascript,
): Promise<AppleScriptOutcome> {
  const script = scriptFor(bundleId, nonce);
  if (script === null) {
    osascript.log(`raise: no window-targeting script for ${bundleId}`);
    return "unsupported";
  }

  const { code, stderr } = await osascript.run(script);
  if (code === 0) return "raised";

  const reported = errorCode(stderr);
  const outcome = classify(reported);
  osascript.log(
    `raise: ${bundleId} answered ${reported ?? "no code"} (${outcome})${
      outcome === "denied"
        ? " — Automation is denied to Stream Deck for this app, and macOS will not ask again; System Settings › Privacy & Security › Automation is the only way back"
        : ""
    }`,
  );
  return outcome;
}
