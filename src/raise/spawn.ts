/**
 * The process-level half of the raise: find the binaries, spawn them, and turn
 * every way that can go wrong into an exit code.
 *
 * Kept apart from the rungs so that their decisions — one re-query, decline
 * rather than guess, classify by numeric code — are testable without a window
 * manager, a terminal or an Automation grant, and so that this file holds
 * nothing but plumbing.
 *
 * Every binary is spawned by absolute path. A Stream Deck plugin's PATH is
 * launchd's `/usr/bin:/bin:/usr/sbin:/sbin` — measured, not assumed — so a bare
 * name is `ENOENT` however the user installed the thing.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

import streamDeck from "@elgato/streamdeck";

import { type Aerospace, findAerospace } from "./aerospace.js";
import { raiseByAppleScript } from "./applescript.js";
import { type Discovery, discoverHostApp } from "./hostapp.js";
import { describeRaise, type RaiseReport, raiseLadder } from "./ladder.js";

/** How long to let a window-manager or discovery call run before giving up on it. */
const SPAWN_TIMEOUT_MS = 2000;

/**
 * The same, for `osascript`. Longer because an Apple Event to an application
 * that is busy — or that has never been spoken to before, and so is being
 * launched by the event itself — is the slowest thing the ladder does.
 */
const OSASCRIPT_TIMEOUT_MS = 5000;

/** One subprocess, reduced to what the rungs read. Never throws. */
function run(
  file: string,
  argv: readonly string[],
  timeout = SPAWN_TIMEOUT_MS,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, [...argv], { timeout }, (err, stdout, stderr) =>
      resolve({
        code: err === null ? 0 : typeof err.code === "number" ? err.code : 1,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
      }),
    );
  });
}

/**
 * The window-manager probe, run once at load and cached for the process
 * lifetime, as the spec requires. Installed is not running, though — a binary
 * found here can still exit non-zero at press time, and the ladder's carve-out
 * treats that as "a tiler may still be managing these windows".
 */
const BINARY = findAerospace(existsSync);

const AEROSPACE: Aerospace = {
  binary: BINARY,
  // Only ever reached with a binary in hand: the rung short-circuits on a null
  // one before asking for anything.
  run: (argv) => run(BINARY ?? "", argv),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (message) => streamDeck.logger.debug(message),
};

const DISCOVERY: Discovery = {
  // `-U` restricts lsof to unix sockets, which is what makes this cheap (0.07 s
  // measured); `-F pcdn` is the field-record format the correlation parses. The
  // `WARNING: can't stat()` noise some filesystems provoke goes to stderr and
  // does not corrupt it.
  unixSockets: async () => {
    const { stdout } = await run("/usr/sbin/lsof", ["-U", "-F", "pcdn"]);
    return stdout.length === 0 ? null : stdout;
  },

  // Bare columns: two integers a line, so nothing has to survive a command line
  // with spaces in it. The path is never read — termination is `ppid == 1`.
  processTree: async () => {
    const { code, stdout } = await run("/bin/ps", ["-axo", "pid=,ppid="]);
    return code === 0 ? stdout : null;
  },

  // Process metadata, not UI-element access: verified to need no Accessibility
  // grant. `-1719` — "can't get application process …" — is the clean "not a
  // GUI app" discriminator, and arrives here as a non-zero exit.
  bundleIdOf: async (pid) => {
    const { code, stdout } = await run("/usr/bin/osascript", [
      "-e",
      `tell application "System Events" to tell (first application process whose unix id is ${pid}) to return bundle identifier`,
    ]);
    const bundleId = stdout.trim();
    return code === 0 && bundleId.length > 0 ? bundleId : null;
  },

  log: (message) => streamDeck.logger.debug(message),
};

/** What one press needs to know about the session it is raising for. */
export interface RaiseOptions {
  /** herdr's client socket, which is what the host-app walk correlates against. */
  readonly clientSocketPath: string;
  /** The user's `hostAppBundleId`, used only when the walk names nothing. */
  readonly hostAppBundleId?: string;
}

/**
 * Bring the window carrying `nonce` to the front, as far as the ladder can, and
 * report where it stopped.
 *
 * Nothing here throws. A decline is not a failure: the press's focus has
 * already happened by the time this runs, so the session did move — only the
 * window did not follow. It is the *caller* that decides how to surface that,
 * and the answer is a transient alert rather than the face.
 */
export async function raise(nonce: string, options: RaiseOptions): Promise<RaiseReport> {
  const report = await raiseLadder(nonce, {
    windowManager: AEROSPACE,
    hostApp: () => discoverHostApp(options.clientSocketPath, options.hostAppBundleId, DISCOVERY),
    appleScript: (bundleId, title) =>
      raiseByAppleScript(bundleId, title, {
        run: async (script) => {
          const { code, stderr } = await run(
            "/usr/bin/osascript",
            ["-e", script],
            OSASCRIPT_TIMEOUT_MS,
          );
          return { code, stderr };
        },
        log: (message) => streamDeck.logger.debug(message),
      }),
    activate: async (bundleId) => (await run("/usr/bin/open", ["-b", bundleId])).code === 0,
    log: (message) => streamDeck.logger.debug(message),
  });

  streamDeck.logger.debug(describeRaise(report));
  return report;
}
