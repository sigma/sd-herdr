/**
 * Rung 1 of the raise ladder: ask AeroSpace to bring the marked window forward.
 *
 * It is the first rung for **TCC reasons, not accuracy**. AeroSpace already
 * holds the Accessibility grant; the plugin only spawns a CLI, so an AeroSpace
 * user installs this plugin without ever answering a system security dialog.
 * It is also the only rung that is app-agnostic — it raises a WezTerm window by
 * title, which AppleScript cannot do at all.
 *
 * The rungs below it (an AppleScript table per bundle id, then `open -b`, then
 * declining) are #8's. Note the carve-out this file already implements: when
 * AeroSpace is present and the nonce simply did not match, the answer is
 * **decline**, never an application-level raise — under a tiling window manager
 * that call deterministically fronts the window on the workspace the user is
 * already looking at, which reads as "the button did nothing".
 */

/**
 * Where an installed `aerospace` can be, in probe order.
 *
 * Absolute paths because a Stream Deck plugin's PATH is launchd's
 * `/usr/bin:/bin:/usr/sbin:/sbin` — measured, not assumed — so a bare
 * `aerospace` is `ENOENT` however the user installed it.
 */
export const AEROSPACE_CANDIDATES = [
  "/opt/homebrew/bin/aerospace",
  "/usr/local/bin/aerospace",
  "/run/current-system/sw/bin/aerospace",
  `${process.env.HOME ?? ""}/.nix-profile/bin/aerospace`,
] as const;

/** How long to give the nonce to reach AeroSpace's window list before looking again. */
const RE_QUERY_DELAY_MS = 60;

/** Whether the window came forward. A decline is not a failure — see the header. */
export type RaiseOutcome = "raised" | "declined";

/** Everything the rung needs from the world, so a test can supply all of it. */
export interface Aerospace {
  /** The probed binary, or null when AeroSpace is not installed. */
  readonly binary: string | null;
  /** Run it and collect its exit code and stdout. Never throws. */
  run(argv: readonly string[]): Promise<{ code: number; stdout: string }>;
  /** Wait, for the one re-query. */
  wait(ms: number): Promise<void>;
  log(message: string): void;
}

/** Find the binary once. Callers cache the answer for the process lifetime. */
export function findAerospace(
  exists: (path: string) => boolean,
  candidates: readonly string[] = AEROSPACE_CANDIDATES,
): string | null {
  return candidates.find(exists) ?? null;
}

/**
 * Raise the window whose title carries `nonce`.
 *
 * Every unhappy path lands on `declined`, deliberately: installed ≠ running, so
 * a non-zero exit means AeroSpace is not answering right now, and the press's
 * focus has already happened either way — the session did move, only the window
 * did not follow.
 */
export async function raiseByNonce(nonce: string, aerospace: Aerospace): Promise<RaiseOutcome> {
  if (aerospace.binary === null) return "declined";

  // The nonce reaches a window manager's list in 12–89 ms, so the first query
  // normally finds it. One re-query covers the tail of that range; anything
  // more would hold the press open waiting for a window that is not coming.
  let ids = await matchingWindows(nonce, aerospace);
  if (ids === null) return "declined";
  if (ids.length === 0) {
    await aerospace.wait(RE_QUERY_DELAY_MS);
    ids = await matchingWindows(nonce, aerospace);
    if (ids === null) return "declined";
  }

  const [first, ...rest] = ids;
  if (first === undefined) {
    aerospace.log(`raise: no window carries the nonce ${nonce}; declining rather than guessing`);
    return "declined";
  }
  if (rest.length > 0) {
    aerospace.log(`raise: ${ids.length} windows carry the nonce ${nonce}; taking ${first}`);
  }

  const focus = await aerospace.run(["focus", "--window-id", first]);
  if (focus.code !== 0) {
    aerospace.log(`raise: aerospace focus --window-id ${first} exited ${focus.code}`);
    return "declined";
  }
  return "raised";
}

/**
 * The ids of the windows whose title carries the nonce, or `null` when
 * AeroSpace could not be asked.
 *
 * The listing format is one we choose, so reading it back is a split on the
 * first space rather than anything that has to parse a title: window ids carry
 * no spaces, and everything after the first one is the title, however the
 * terminal decorated it.
 */
async function matchingWindows(nonce: string, aerospace: Aerospace): Promise<string[] | null> {
  const listed = await aerospace.run([
    "list-windows",
    "--monitor",
    "all",
    "--format",
    "%{window-id} %{window-title}",
  ]);
  if (listed.code !== 0) {
    aerospace.log(`raise: aerospace list-windows exited ${listed.code}`);
    return null;
  }

  return listed.stdout
    .split("\n")
    .map((line) => {
      const space = line.indexOf(" ");
      return space < 0 ? null : { id: line.slice(0, space), title: line.slice(space + 1) };
    })
    .filter((window) => window !== null)
    .filter((window) => window.title.includes(nonce))
    .map((window) => window.id);
}
