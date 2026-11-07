/**
 * The Rex press: focus the block, have the app show its tab, bring Rex forward
 * (`docs/research/rex-raise.md`).
 *
 * The first step is the core's `focusPane` effect and the other two are its
 * `raise`, which carries no target. A tile speaks for the whole server and the
 * core names only the block, so the focus finds the session and window holding
 * it, and holds them here for the raise that follows. A press that focused
 * nothing (empty set, grey tile, stale block) selects nothing and only brings
 * Rex forward.
 *
 * No policy lives here beyond choosing the app client; the client and `open`
 * are parameters so the payloads and the outcome mapping are tested without a
 * server.
 */
import type { Requester } from "./client.js";
import { RexError } from "./client.js";
import { decodeView } from "./poll.js";
import { decodeSessions } from "./sessions.js";
import type { SessionView } from "./view.js";

/** The Rex app, Rex Beta included. */
export const REX_BUNDLE_ID = "com.superlogical.rex";

/** How long the app has to answer `session.select`, instead of the API's 10 s. */
export const SELECT_TIMEOUT_MS = 2000;

/** How a press's second and third steps went. */
export interface PressReport {
  /** `skipped` is no app connected: Rex is not showing anything to move. */
  readonly select: "selected" | "skipped" | "failed";
  /** Why `select` failed. */
  readonly selectError?: string;
  /** Whether `open -b` succeeded. */
  readonly opened: boolean;
}

/** The window holding `blockId`, from any layer of the view. */
export function windowOf(view: SessionView, blockId: string): string | null {
  for (const window of view.windows ?? []) {
    for (const layer of window.layers ?? []) {
      if ((layer.blocks ?? []).some((block) => block.block_id === blockId)) {
        return window.window_id;
      }
    }
  }
  return null;
}

interface ListedClient {
  readonly client_id?: string;
  readonly info?: { readonly kind?: string };
  readonly principal?: { readonly transport?: string };
  readonly connection_state?: string;
}

/**
 * The local Rex app: connected, `kind` app, over the unix socket. A paired
 * phone or another Mac is an app too, but not this machine's window.
 */
export function appClientId(payload: unknown): string | null {
  const clients = (payload as { clients?: readonly ListedClient[] | null } | null)?.clients ?? [];
  const app = clients.find(
    (client) =>
      client.info?.kind === "app" &&
      client.principal?.transport === "unix" &&
      // A missing state reads as connected, as the API says.
      (client.connection_state ?? "connected") === "connected",
  );
  return typeof app?.client_id === "string" ? app.client_id : null;
}

/** The `client.perform` payload that makes the app show a session at one tab. */
export function selectPayload(clientId: string, sessionId: string, windowId: string) {
  return {
    client_id: clientId,
    action: "session.select",
    args: { session_id: sessionId, window_id: windowId },
    timeout_ms: SELECT_TIMEOUT_MS,
  };
}

/** What to tell the user when a press did not fully land; `null` when it did (or was merely skipped). */
export function describePress(report: PressReport): string | null {
  const problems: string[] = [];
  if (report.select === "failed") {
    problems.push(`the Rex app did not show the tab (${report.selectError ?? "unknown"})`);
  }
  if (!report.opened) problems.push(`open -b ${REX_BUNDLE_ID} failed`);
  return problems.length === 0 ? null : problems.join("; ");
}

/** Where a block lives: what `session.focus_block` and `session.select` need. */
interface Place {
  readonly sessionId: string;
  readonly windowId: string;
}

export class RexPress {
  private aimed: Place | null = null;

  constructor(
    private readonly client: Requester,
    private readonly open: (bundleId: string) => Promise<boolean>,
  ) {}

  /**
   * The session and window holding `blockId`, from a fresh read of the server.
   * A session that fails to read is passed over: an unrelated session timing
   * out must not fail a press onto another. Only when no session holds the
   * block does a failure count, since the block may have been in it.
   */
  private async locate(blockId: string): Promise<Place | null> {
    const sessions = decodeSessions(await this.client.request("session.list", {}));
    const reads = await Promise.allSettled(
      sessions.map(async ({ session_id: sessionId }): Promise<Place | null> => {
        const view = decodeView(
          await this.client.request("session.view", { session_id: sessionId }),
        );
        const windowId = windowOf(view, blockId);
        return windowId === null ? null : { sessionId, windowId };
      }),
    );
    for (const read of reads)
      if (read.status === "fulfilled" && read.value !== null) return read.value;
    const failure = reads.find(
      (read): read is PromiseRejectedResult =>
        read.status === "rejected" &&
        !(read.reason instanceof RexError && read.reason.code === "session_not_found"),
    );
    if (failure !== undefined) throw failure.reason;
    return null;
  }

  /**
   * Step 1. Rejects when the block is gone (`not_found`), which the runner
   * turns into the core's failed focus. The block is located first, so one that
   * closed since the poll fails here without moving anything.
   */
  async focus(blockId: string): Promise<void> {
    this.aimed = null;
    const place = await this.locate(blockId);
    if (place === null) throw new RexError("not_found", `block ${blockId} is on no session`);
    await this.client.request("session.focus_block", {
      session_id: place.sessionId,
      block_id: blockId,
    });
    this.aimed = place;
  }

  /** Steps 2 and 3. Never throws; step 3 runs whatever step 2 did. */
  async raise(): Promise<PressReport> {
    const place = this.aimed;
    this.aimed = null;

    let select: PressReport["select"] = "skipped";
    let selectError: string | undefined;
    // Nothing was focused, so there is nothing to show: bring Rex forward and
    // nothing more.
    if (place !== null) {
      try {
        const clientId = appClientId(await this.client.request("client.list", {}));
        if (clientId !== null) {
          await this.client.request(
            "client.perform",
            selectPayload(clientId, place.sessionId, place.windowId),
          );
          select = "selected";
        }
      } catch (err) {
        select = "failed";
        selectError = err instanceof RexError ? err.code : String(err);
      }
    }
    const opened = await this.open(REX_BUNDLE_ID).catch(() => false);
    return { select, selectError, opened };
  }
}
