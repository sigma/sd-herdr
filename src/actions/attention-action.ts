import { homedir } from "node:os";
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
import { HERDR } from "../herdr/backend.js";
import { clearWindowTitle, focusPane, ping, setWindowTitle, snapshot } from "../herdr/client.js";
import { fromHerdr } from "../herdr/convert.js";
import { clientSocketPathFor, DEFAULT_SESSION, socketPathFor } from "../herdr/session.js";
import { describeRaise } from "../raise/ladder.js";
import { openBundle, raise } from "../raise/spawn.js";
import { REX } from "../rex/backend.js";
import { openRexSocket, RexControl } from "../rex/client.js";
import { pollServer } from "../rex/poll.js";
import { describePress, RexPress } from "../rex/press.js";
import { rexSocketPath } from "../rex/session.js";

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

/** What a button remembers. The settings are per-button; the poll loop is not. */
interface ButtonSettings {
  /** `rex` for Rex; anything else, or nothing, is herdr, so an existing key is unchanged. */
  readonly backend?: string;
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

/** The clock and the log, which are the same whichever backend a hub speaks for. */
const environment = {
  now: () => Date.now(),
  report: (message: string) => streamDeck.logger.warn(message),
  schedule: (ms: number, fn: () => void) => {
    const handle = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(handle) };
  },
};

/**
 * The herdr hub, and so the one place a herdr poll loop can be shared.
 * Module-level rather than per-action-instance because sharing is by *socket
 * path*: two keys pointed at one session share a loop wherever they sit. A hub
 * takes one backend's adapters, so Rex has a hub of its own below.
 */
const hub = new SessionHub({
  backend: HERDR,
  // herdr's session key is its socket path, so the key goes straight through.
  snapshot: async (socketPath) => fromHerdr(await snapshot(socketPath)),
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
  ...environment,
});

/** The local Rex server's socket, which is also the Rex hub's one session key. */
const REX_SOCKET = rexSocketPath(homedir());

/**
 * The one control connection to the Rex server, shared by every Rex tile. It
 * connects only while a tile has retained it, and the hello's version is read
 * when it first connects, which is after the SDK has registered.
 */
const rexControl = new RexControl(
  () => openRexSocket(REX_SOCKET),
  () => streamDeck.info.plugin.version,
);

/** The Rex press: its focus step is the hub's `focusPane`, its raise is per key. */
const rexPress = new RexPress(rexControl, openBundle);

/**
 * The Rex hub. A Rex tile speaks for the whole local server, so there is one
 * session key, the server's socket path, and every Rex tile shares one poll
 * loop here as two herdr tiles on one session do.
 */
const rexHub = new SessionHub({
  backend: REX,
  snapshot: () => pollServer(rexControl),
  // A record of which Rex this tile talked to, as for herdr.
  ping: async () => {
    const status = (await rexControl.request("server.status", {})) as { api_revision?: unknown };
    streamDeck.logger.info(`rex, api revision ${String(status.api_revision)}`);
  },
  // Nothing is written into a window title on Rex (`marksWindow` is false), so
  // the core never emits these.
  setTitle: async () => {},
  clearTitle: async () => {},
  // Step 1 of the press; a rejection is the core's failed focus.
  focusPane: (_server, blockId) => rexPress.focus(blockId),
  ...environment,
});

/** What a key speaks for: a herdr session, or the whole Rex server. */
type Target =
  | { readonly backend: "herdr"; readonly sessionName: string }
  | { readonly backend: "rex" };

function targetOf(settings: ButtonSettings): Target {
  if (settings.backend === "rex") return { backend: "rex" };
  return { backend: "herdr", sessionName: configured(settings.sessionName, DEFAULT_SESSION) };
}

/** Equal targets are the same session; this is what "already pointed there" compares. */
function targetKey(target: Target): string {
  return target.backend === "rex" ? "rex" : `herdr:${target.sessionName}`;
}

/**
 * The attention button: one tile per herdr session, or one for the whole Rex
 * server, red while any agent in it is blocked.
 *
 * Everything with an opinion lives behind the core; this class is the Stream
 * Deck end of the wire. It maps the SDK's lifecycle onto a membership of the
 * session hub, and remembers which session each key is currently pointed at so
 * that a settings change can repoint it.
 */
@action({ UUID: "dev.yrh.sd-mux.attention" })
export class AttentionAction extends SingletonAction {
  private readonly buttons = new Map<string, { membership: Membership; target: string }>();

  override onWillAppear(ev: WillAppearEvent): void {
    if (!ev.action.isKey()) return;
    this.point(ev.action, targetOf(ev.payload.settings as ButtonSettings));
  }

  /**
   * The property inspector wrote a setting.
   *
   * Only the backend and the session are acted on here: they are what the poll
   * loop and the cycle are keyed on. `hostAppBundleId` is read at press time instead, so
   * changing it takes effect on the next press without disturbing anything.
   */
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent): void {
    if (!ev.action.isKey()) return;
    this.point(ev.action, targetOf(ev.payload.settings as ButtonSettings));
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
  private point(key: KeyAction, target: Target): void {
    const id = targetKey(target);
    const current = this.buttons.get(key.id);
    if (current?.target === id) return;

    const membership = target.backend === "rex" ? this.joinRex(key) : this.joinHerdr(key, target);
    // Joined before the old one is left, so the shared loop and connection are
    // never dropped in between.
    current?.membership.leave();
    this.buttons.set(key.id, { membership, target: id });
  }

  private joinHerdr(key: KeyAction, target: { readonly sessionName: string }): Membership {
    const { sessionName } = target;
    return hub.join(sessionName, socketPathFor(sessionName), {
      paint: (face) => paint(key, face),
      raise: (nonce) => raiseFor(key, sessionName, nonce),
    });
  }

  /**
   * A Rex tile retains the shared connection for as long as it is visible, so
   * the connection is open exactly while one is.
   */
  private joinRex(key: KeyAction): Membership {
    const release = rexControl.retain();
    const membership = rexHub.join("rex", REX_SOCKET, {
      paint: (face) => paint(key, face),
      // Steps 2 and 3. There is no nonce: `marksWindow` is false.
      raise: () => rexRaiseFor(key),
    });
    return {
      press: () => membership.press(),
      leave: () => {
        membership.leave();
        release();
      },
    };
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
 * Show the focused agent's tab in the Rex app and bring Rex forward, alerting on the key
 * (never the face) when either step failed, as `raiseFor` does for herdr.
 */
async function rexRaiseFor(key: KeyAction): Promise<void> {
  const report = await rexPress.raise();
  const degraded = describePress(report);
  if (degraded === null) return;
  streamDeck.logger.info(`degraded: ${degraded}`);
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
