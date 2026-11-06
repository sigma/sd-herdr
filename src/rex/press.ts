/**
 * The Rex press: focus the block, have the app show its tab, bring Rex forward
 * (`docs/research/rex-raise.md`).
 *
 * The first step is the core's `focusPane` effect and the other two are its
 * `raise`, which carries no target. So the window the focus aimed at is held
 * here between the two, per session, and taken by the raise that follows. A
 * press that focused nothing (empty set, grey tile, stale block) therefore
 * selects the session without a window.
 *
 * No policy lives here beyond choosing the app client; the client and `open`
 * are parameters so the payloads and the outcome mapping are tested without a
 * server.
 */
import type { Requester } from "./client.js";
import { RexError } from "./client.js";
import { decodeView } from "./poll.js";
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

/** The `client.perform` payload that makes the app show a session, and a tab if there is one. */
export function selectPayload(clientId: string, sessionId: string, windowId: string | null) {
  return {
    client_id: clientId,
    action: "session.select",
    args:
      windowId === null
        ? { session_id: sessionId }
        : { session_id: sessionId, window_id: windowId },
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

export class RexPress {
  private readonly aimed = new Map<string, string>();

  constructor(
    private readonly client: Requester,
    private readonly open: (bundleId: string) => Promise<boolean>,
  ) {}

  /**
   * Step 1. Rejects when the block is gone (`not_found`), which the runner
   * turns into the core's failed focus. The window is looked up first, so a
   * block that closed since the poll fails here without moving anything.
   */
  async focus(sessionId: string, blockId: string): Promise<void> {
    this.aimed.delete(sessionId);
    const view = decodeView(await this.client.request("session.view", { session_id: sessionId }));
    const windowId = windowOf(view, blockId);
    if (windowId === null) throw new RexError("not_found", `block ${blockId} is not in the view`);
    await this.client.request("session.focus_block", { session_id: sessionId, block_id: blockId });
    this.aimed.set(sessionId, windowId);
  }

  /** Steps 2 and 3. Never throws; step 3 runs whatever step 2 did. */
  async raise(sessionId: string): Promise<PressReport> {
    const windowId = this.aimed.get(sessionId) ?? null;
    this.aimed.delete(sessionId);

    let select: PressReport["select"] = "skipped";
    let selectError: string | undefined;
    // A tile with no session chosen has nothing to show: bring Rex forward and
    // nothing more, rather than asking the server and alerting on its refusal.
    if (sessionId === "") {
      const opened = await this.open(REX_BUNDLE_ID).catch(() => false);
      return { select, opened };
    }
    try {
      const clientId = appClientId(await this.client.request("client.list", {}));
      if (clientId !== null) {
        await this.client.request("client.perform", selectPayload(clientId, sessionId, windowId));
        select = "selected";
      }
    } catch (err) {
      select = "failed";
      selectError = err instanceof RexError ? err.code : String(err);
    }
    const opened = await this.open(REX_BUNDLE_ID).catch(() => false);
    return { select, selectError, opened };
  }
}
