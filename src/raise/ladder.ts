/**
 * The raise ladder: the ordered mechanisms tried until one of them brings the
 * host terminal window forward, each a **rung**.
 *
 * ```
 * 1  window manager   ask AeroSpace to raise the window carrying the nonce
 * 2  AppleScript      ask the terminal application, by bundle id
 * 3  open -b          activate the application, any window of it
 * 4  decline          refuse, rather than reach for a rung known to be wrong
 * ```
 *
 * **The order is chosen for TCC, not for accuracy.** Rung 1 needs no Automation
 * grant of its own, so an AeroSpace user is never shown a system security
 * dialog by this plugin at all. It is also the only ordering whose behaviour
 * does not vary with which terminal the session happens to be attached from.
 *
 * **The carve-out: with a window manager present and the nonce unmatched, the
 * ladder declines rather than falling through.** Under a tiler `open -b`
 * deterministically fronts the window on the workspace the user is already
 * looking at, which looks like success and is not; and rung 2 would be asking
 * for an Automation grant to find the very window rung 1 just failed to find,
 * by the same title. Declining is not a failure — the press's focus has already
 * happened, so the session did move, and only the window did not follow.
 */
import { type Aerospace, raiseByNonce } from "./aerospace.js";
import type { AppleScriptOutcome } from "./applescript.js";
import type { HostApp } from "./hostapp.js";

/**
 * How far the ladder got.
 *
 * `raised` is an **exact** raise — the one window carrying the nonce. `activated`
 * is not: it brings *an* application window forward, which is the best rung 3
 * can promise. The distinction is the whole reason the two are separate values.
 */
export type RaiseOutcome = "raised" | "activated" | "declined";

/** Which rung answered, for the log line and for the tests. */
export type Rung = "window-manager" | "applescript" | "open" | "none";

export interface RaiseReport {
  readonly outcome: RaiseOutcome;
  readonly rung: Rung;
  /** Why, in one line the user can act on. */
  readonly detail: string;
  /**
   * Whether the host app came from the `hostAppBundleId` setting rather than
   * from discovery. Surfaced because a silent permanent fallback is how a
   * broken walk goes unnoticed for months.
   */
  readonly usedConfiguredHostApp: boolean;
}

/**
 * One line saying where the ladder stopped and why.
 *
 * Lives with the report rather than at either call site: the plugin's entire
 * output is an image on a physical key, so the log is the only record of what a
 * press actually did, and two call sites wording it differently would make one
 * press look like two events.
 */
export function describeRaise(report: RaiseReport): string {
  const via = report.usedConfiguredHostApp ? ", via the configured host app" : "";
  const why = report.detail === "" ? "" : ` — ${report.detail}`;
  return `raise ${report.outcome} at rung ${report.rung}${via}${why}`;
}

/** Everything the ladder needs from the world, so a test can supply all of it. */
export interface RaiseWorld {
  /** Rung 1. A null binary means no window manager is installed. */
  readonly windowManager: Aerospace;
  /** Rung 2's prerequisite: which application to talk to, and how we know. */
  hostApp(): Promise<HostApp | null>;
  /** Rung 2. */
  appleScript(bundleId: string, nonce: string): Promise<AppleScriptOutcome>;
  /** Rung 3: `open -b`. False when the application could not be activated. */
  activate(bundleId: string): Promise<boolean>;
  log(message: string): void;
}

/** Climb the ladder for one press, and report where it stopped. */
export async function raiseLadder(nonce: string, world: RaiseWorld): Promise<RaiseReport> {
  if (world.windowManager.binary !== null) {
    const outcome = await raiseByNonce(nonce, world.windowManager);
    if (outcome === "raised") {
      return {
        outcome: "raised",
        rung: "window-manager",
        detail: "",
        usedConfiguredHostApp: false,
      };
    }
    // The carve-out. Note what is *not* here: no fall-through to rung 2, and so
    // no Apple Event, and so no Automation dialog, on any machine running a
    // supported window manager.
    return {
      outcome: "declined",
      rung: "window-manager",
      detail: "the window manager could not find the marked window; declining rather than guessing",
      usedConfiguredHostApp: false,
    };
  }

  const host = await world.hostApp();
  if (host === null) {
    return {
      outcome: "declined",
      rung: "none",
      detail: "cannot tell which application hosts this session; set hostAppBundleId to say",
      usedConfiguredHostApp: false,
    };
  }
  const usedConfiguredHostApp = host.source === "setting";

  const scripted = await world.appleScript(host.bundleId, nonce);
  if (scripted === "raised") {
    return { outcome: "raised", rung: "applescript", detail: "", usedConfiguredHostApp };
  }

  // Every non-exact rung-2 answer lands here, including a denial: after a
  // refusal every attempt returns the same code and macOS never re-prompts, so
  // there is nothing to retry and nothing to wait for.
  const activated = await world.activate(host.bundleId);
  return activated
    ? {
        outcome: "activated",
        rung: "open",
        detail: `raised ${host.bundleId}, but not a specific window (${scripted})`,
        usedConfiguredHostApp,
      }
    : {
        outcome: "declined",
        rung: "open",
        detail: `could not activate ${host.bundleId} (${scripted})`,
        usedConfiguredHostApp,
      };
}
