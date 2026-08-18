import streamDeck, {
  action,
  type KeyAction,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { Runner } from "../core/runner.js";
import type { FaceDescriptor } from "../face/descriptor.js";
import { renderFaceSvg, svgToImageUri } from "../face/render.js";
import { clearWindowTitle, focusPane, ping, setWindowTitle, snapshot } from "../herdr/client.js";
import { clientSocketPathFor, socketPathFor } from "../herdr/session.js";
import { describeRaise } from "../raise/ladder.js";
import { raise } from "../raise/spawn.js";

/**
 * The session this button speaks for. A constant until #27, which makes it a
 * per-button setting and lets one Stream Deck watch several sessions.
 */
const SESSION_NAME = "default";

/**
 * What a button remembers. `hostAppBundleId` is the raise ladder's last resort:
 * it names the terminal application to raise when the process walk cannot —
 * a client inside tmux or zellij, or over SSH. Unset by default, because
 * guessing a terminal the user does not run would raise the wrong window and
 * call it success.
 *
 * ⚠️ There is no property inspector yet, so nothing can write this today: the
 * plugin reads a setting the user has no dialog for until #27 builds one,
 * alongside the per-button session name.
 */
interface ButtonSettings {
  readonly hostAppBundleId?: string;
  /** The SDK stores settings as free JSON; this says so without importing its type. */
  readonly [key: string]: string | undefined;
}

/**
 * The attention button: one tile per herdr session, red while any agent in it
 * is blocked.
 *
 * Everything with an opinion lives behind the core; this class is the Stream
 * Deck end of the wire. It maps the SDK's lifecycle onto the runner and hands
 * back a way to paint, and holds one runner per action instance so two buttons
 * on two devices do not share a poll loop.
 */
@action({ UUID: "dev.yrh.sd-herdr.attention" })
export class AttentionAction extends SingletonAction {
  private readonly runners = new Map<string, Runner>();

  override onWillAppear(ev: WillAppearEvent): void {
    if (!ev.action.isKey()) return;
    this.runnerFor(ev.action).appeared();
  }

  override onKeyDown(ev: KeyDownEvent): void {
    if (!ev.action.isKey()) return;
    this.runnerFor(ev.action).pressed();
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const runner = this.runners.get(ev.action.id);
    if (runner === undefined) return;
    // The button is gone, and so is the reason to poll — and with it the press
    // cycle, whose visited set the core discards on this event.
    runner.disappeared();
    this.runners.delete(ev.action.id);
  }

  private runnerFor(key: KeyAction): Runner {
    const existing = this.runners.get(key.id);
    if (existing !== undefined) return existing;

    const runner = new Runner(SESSION_NAME, socketPathFor(SESSION_NAME), {
      snapshot,
      // The pong goes to the log and nowhere else. It is the record of which
      // herdr this button spent its life talking to — the one thing that makes
      // a version skew after a herdr update readable after the fact.
      ping: async (socketPath) => {
        const pong = await ping(socketPath);
        streamDeck.logger.info(`herdr ${pong.version}, protocol ${pong.protocol}`);
      },
      // The reason is logged rather than branched on: `no_foreground_client`
      // means there is no attached terminal, and the raise then finds no window
      // carrying the nonce and declines — the same outcome, one path.
      setTitle: async (socketPath, nonce) => {
        const reason = await setWindowTitle(socketPath, nonce);
        if (reason !== "set") streamDeck.logger.debug(`window title not set: ${reason}`);
      },
      clearTitle: async (socketPath) => {
        await clearWindowTitle(socketPath);
      },
      focusPane,
      raise: (nonce) => raiseFor(key, nonce),
      paint: (descriptor) => paint(key, descriptor),
      now: () => Date.now(),
      report: (message) => streamDeck.logger.warn(message),
      schedule: (ms, fn) => {
        const handle = setTimeout(fn, ms);
        return { cancel: () => clearTimeout(handle) };
      },
    });
    this.runners.set(key.id, runner);
    return runner;
  }
}

/**
 * Climb the raise ladder for one press, and tell the user when it did not end
 * in an exact raise.
 *
 * The signal is a **transient alert on the key, never the face**. A raise
 * outcome is per-press; the face is session state. Painting "the window did not
 * follow" onto the tile would make a momentary event look like a standing
 * condition, and it would collide with the colour the tile already owes to the
 * attention set.
 *
 * The configured host app raises the same alert even on an exact raise: it
 * means the process walk found nothing, and a silent permanent fallback is how
 * a broken walk goes unnoticed for months.
 */
async function raiseFor(key: KeyAction, nonce: string): Promise<void> {
  const { hostAppBundleId } = await key.getSettings<ButtonSettings>();
  const report = await raise(nonce, {
    clientSocketPath: clientSocketPathFor(SESSION_NAME),
    hostAppBundleId,
  });
  if (report.outcome === "raised" && !report.usedConfiguredHostApp) return;
  streamDeck.logger.info(`degraded: ${describeRaise(report)}`);
  await key.showAlert();
}

/**
 * Draw a face onto a key. The only place the SDK and the renderer meet.
 *
 * The descriptor is logged because it is otherwise unobservable: the plugin's
 * entire output is an image on a physical key, and the runner draws only on a
 * change, so this line is the record of what the tile said and when.
 */
function paint(key: KeyAction, face: FaceDescriptor): Promise<void> {
  streamDeck.logger.debug(`face ${JSON.stringify(face)}`);
  return key.setImage(svgToImageUri(renderFaceSvg(face)));
}
