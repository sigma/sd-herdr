/**
 * The process-level half of the raise: find the binary once, spawn it, and turn
 * every way that can go wrong into an exit code.
 *
 * Kept apart from `aerospace.ts` so that the rung's decisions — one re-query,
 * first of several matches, decline rather than guess — are testable without a
 * window manager, and so that this file holds nothing but plumbing.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

import streamDeck from "@elgato/streamdeck";

import { type Aerospace, findAerospace, raiseByNonce } from "./aerospace.js";

/** How long to let a window-manager call run before giving up on it. */
const SPAWN_TIMEOUT_MS = 2000;

/**
 * The probe, run once at load and cached for the process lifetime, as the spec
 * requires. Installed is not running, though — a binary found here can still
 * exit non-zero at press time, and that falls through like any other decline.
 */
const BINARY = findAerospace(existsSync);

const AEROSPACE: Aerospace = {
  binary: BINARY,

  // Only ever reached with a binary in hand: the rung short-circuits on a null
  // one before asking for anything.
  run: (argv) =>
    new Promise((resolve) => {
      execFile(BINARY ?? "", [...argv], { timeout: SPAWN_TIMEOUT_MS }, (err, stdout) =>
        resolve({
          code: err === null ? 0 : typeof err.code === "number" ? err.code : 1,
          stdout: stdout ?? "",
        }),
      );
    }),

  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),

  log: (message) => streamDeck.logger.debug(message),
};

/**
 * Bring the window carrying `nonce` to the front, as far as rung 1 can.
 *
 * A decline is logged rather than raised to the caller: the press's focus has
 * already happened by the time this runs, so the session did move — only the
 * window did not follow, and that is not a failure of the press.
 */
export async function raise(nonce: string): Promise<void> {
  const outcome = await raiseByNonce(nonce, AEROSPACE);
  streamDeck.logger.debug(`raise ${outcome}${BINARY === null ? " (no window manager found)" : ""}`);
}
