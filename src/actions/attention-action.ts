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
import { clearWindowTitle, focusPane, setWindowTitle, snapshot } from "../herdr/client.js";
import { socketPathFor } from "../herdr/session.js";
import { raise } from "../raise/spawn.js";

/**
 * The session this button speaks for. A constant until #27, which makes it a
 * per-button setting and lets one Stream Deck watch several sessions.
 */
const SESSION_NAME = "default";

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
    // The button is gone, and so is the reason to poll. The visited set is
    // cleared on willDisappear too — but that is #23's, once a cycle exists.
    runner.disappeared();
    this.runners.delete(ev.action.id);
  }

  private runnerFor(key: KeyAction): Runner {
    const existing = this.runners.get(key.id);
    if (existing !== undefined) return existing;

    const runner = new Runner(SESSION_NAME, socketPathFor(SESSION_NAME), {
      snapshot,
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
      raise,
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
