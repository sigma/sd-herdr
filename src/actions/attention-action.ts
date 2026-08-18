import streamDeck, {
  action,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { type Membership, SessionHub } from "../core/hub.js";
import type { FaceDescriptor } from "../face/descriptor.js";
import { renderFaceSvg, svgToImageUri } from "../face/render.js";
import { clearWindowTitle, focusPane, ping, setWindowTitle, snapshot } from "../herdr/client.js";
import { clientSocketPathFor, DEFAULT_SESSION, socketPathFor } from "../herdr/session.js";
import { describeRaise } from "../raise/ladder.js";
import { raise } from "../raise/spawn.js";

/**
 * The terminal the raise ladder falls back to when it cannot name the one
 * hosting the session — a client inside tmux or zellij, or over SSH, where the
 * process walk has nothing to walk.
 *
 * It has a default, and the default is announced rather than assumed: every
 * press that leans on it raises an alert on the key and logs the reason, so a
 * user running some other terminal finds out on the first press instead of
 * wondering for months why the wrong window keeps coming forward.
 */
const DEFAULT_HOST_APP = "com.mitchellh.ghostty";

/** What a button remembers. Both settings are per-button; the poll loop is not. */
interface ButtonSettings {
  readonly sessionName?: string;
  readonly hostAppBundleId?: string;
  /** The SDK stores settings as free JSON; this says so without importing its type. */
  readonly [key: string]: string | undefined;
}

/**
 * A setting, or what stands in for it when the user has left it blank. One rule
 * for both settings: the inspector writes `""` for a field the user cleared,
 * and an empty session name means "the one I never configured", not a session
 * with no name. A fresh button therefore works without the inspector being
 * opened at all.
 */
function configured(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? fallback : trimmed;
}

/**
 * The one hub for the whole plugin, and so the one place a poll loop can be
 * shared. Module-level rather than per-action-instance because sharing is by
 * *socket path*: two keys pointed at one session share a loop wherever they sit.
 */
const hub = new SessionHub({
  snapshot,
  // The pong goes to the log and nowhere else. It is the record of which herdr
  // this button spent its life talking to — the one thing that makes a version
  // skew after a herdr update readable after the fact.
  ping: async (socketPath) => {
    const pong = await ping(socketPath);
    streamDeck.logger.info(`herdr ${pong.version}, protocol ${pong.protocol}`);
  },
  // The reason is logged rather than branched on: `no_foreground_client` means
  // there is no attached terminal, and the raise then finds no window carrying
  // the nonce and declines — the same outcome, one path.
  setTitle: async (socketPath, nonce) => {
    const reason = await setWindowTitle(socketPath, nonce);
    if (reason !== "set") streamDeck.logger.debug(`window title not set: ${reason}`);
  },
  clearTitle: async (socketPath) => {
    await clearWindowTitle(socketPath);
  },
  focusPane,
  now: () => Date.now(),
  report: (message) => streamDeck.logger.warn(message),
  schedule: (ms, fn) => {
    const handle = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(handle) };
  },
});

/**
 * The attention button: one tile per herdr session, red while any agent in it
 * is blocked.
 *
 * Everything with an opinion lives behind the core; this class is the Stream
 * Deck end of the wire. It maps the SDK's lifecycle onto a membership of the
 * session hub, and remembers which session each key is currently pointed at so
 * that a settings change can repoint it.
 */
@action({ UUID: "dev.yrh.sd-herdr.attention" })
export class AttentionAction extends SingletonAction {
  private readonly buttons = new Map<string, { membership: Membership; sessionName: string }>();

  override onWillAppear(ev: WillAppearEvent): void {
    if (!ev.action.isKey()) return;
    this.point(
      ev.action,
      configured((ev.payload.settings as ButtonSettings).sessionName, DEFAULT_SESSION),
    );
  }

  /**
   * The property inspector wrote a setting.
   *
   * Only the session name is acted on here: it is what the poll loop and the
   * cycle are keyed on. `hostAppBundleId` is read at press time instead, so
   * changing it takes effect on the next press without disturbing anything.
   */
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent): void {
    if (!ev.action.isKey()) return;
    this.point(
      ev.action,
      configured((ev.payload.settings as ButtonSettings).sessionName, DEFAULT_SESSION),
    );
  }

  override onKeyDown(ev: KeyDownEvent): void {
    if (!ev.action.isKey()) return;
    this.buttons.get(ev.action.id)?.membership.press();
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const button = this.buttons.get(ev.action.id);
    if (button === undefined) return;
    // The button is gone, and so is the reason to poll — and, if it was the
    // last one on this session, the press cycle with it.
    button.membership.leave();
    this.buttons.delete(ev.action.id);
  }

  /**
   * Point one key at one session, leaving whatever it was pointed at before.
   *
   * A key already on the right session is left alone, and that guard is
   * load-bearing rather than tidy: `raiseFor` calls `getSettings`, which the
   * app answers with a `didReceiveSettings` — so this runs on **every press**.
   * Rejoining unconditionally would restart the poll loop and reset the cycle
   * each time the button was pressed.
   */
  private point(key: KeyAction, sessionName: string): void {
    const current = this.buttons.get(key.id);
    if (current?.sessionName === sessionName) return;
    current?.membership.leave();

    const membership = hub.join(sessionName, socketPathFor(sessionName), {
      paint: (face) => paint(key, face),
      raise: (nonce) => raiseFor(key, sessionName, nonce),
    });
    this.buttons.set(key.id, { membership, sessionName });
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
 * The host app raises the same alert even on an exact raise: it means the
 * process walk found nothing and the configured bundle id — the user's, or the
 * default standing in for it — decided where the press landed. That is the one
 * rung that cannot verify its own target, so its use is never silent.
 */
async function raiseFor(key: KeyAction, sessionName: string, nonce: string): Promise<void> {
  const { hostAppBundleId } = await key.getSettings<ButtonSettings>();
  const report = await raise(nonce, {
    clientSocketPath: clientSocketPathFor(sessionName),
    hostAppBundleId: configured(hostAppBundleId, DEFAULT_HOST_APP),
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
