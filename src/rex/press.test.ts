import { describe, expect, it } from "vitest";

import { type Requester, RexError } from "./client.js";
import {
  appClientId,
  describePress,
  REX_BUNDLE_ID,
  RexPress,
  SELECT_TIMEOUT_MS,
  selectPayload,
  windowOf,
} from "./press.js";
import type { SessionView } from "./view.js";

const view: SessionView = {
  windows: [
    { window_id: "w1", layers: [{ kind: "tiled", blocks: [{ block_id: "b1" }] }] },
    {
      window_id: "w2",
      layers: [
        { kind: "tiled", blocks: [{ block_id: "b2" }] },
        { kind: "float", blocks: [{ block_id: "b3" }] },
      ],
    },
  ],
};

const client = (clientId: string, kind: string | undefined, transport: string, state?: string) => ({
  client_id: clientId,
  ...(kind === undefined ? {} : { info: { kind } }),
  principal: { kind: "peer", transport },
  ...(state === undefined ? {} : { connection_state: state }),
});

describe("windowOf", () => {
  it("finds the window of a block in any layer", () => {
    expect(windowOf(view, "b1")).toBe("w1");
    expect(windowOf(view, "b3")).toBe("w2");
    expect(windowOf(view, "gone")).toBeNull();
  });
});

describe("appClientId", () => {
  it("picks the connected app over the unix socket", () => {
    const clients = [
      client("cli", "cli", "unix"),
      client("noinfo", undefined, "unix"),
      client("phone", "app", "tailscale"),
      client("lost", "app", "unix", "lost"),
      client("app", "app", "unix", "connected"),
    ];
    expect(appClientId({ clients })).toBe("app");
  });

  it("is null with none, or with a null list", () => {
    expect(appClientId({ clients: [client("cli", "cli", "unix")] })).toBeNull();
    expect(appClientId({ clients: null })).toBeNull();
  });
});

describe("selectPayload", () => {
  it("names the session and the window", () => {
    expect(selectPayload("c", "s", "w1")).toEqual({
      client_id: "c",
      action: "session.select",
      args: { session_id: "s", window_id: "w1" },
      timeout_ms: SELECT_TIMEOUT_MS,
    });
  });
});

describe("describePress", () => {
  it("is silent for a clean press and for no app connected", () => {
    expect(describePress({ select: "selected", opened: true })).toBeNull();
    expect(describePress({ select: "skipped", opened: true })).toBeNull();
  });

  it("names each failed step", () => {
    expect(describePress({ select: "failed", selectError: "timeout", opened: true })).toContain(
      "timeout",
    );
    expect(describePress({ select: "selected", opened: false })).toContain(REX_BUNDLE_ID);
  });
});

/**
 * A requester that records calls and answers from a table, failing the methods
 * it is told to. `session.view` answers per session: `views` maps a session id
 * to its view, and a session missing from it is `session_not_found`.
 */
function fake(
  answers: Record<string, unknown>,
  failing: Record<string, string> = {},
  views: Record<string, SessionView> = { s: view },
) {
  const calls: Array<[string, object]> = [];
  const requester: Requester = {
    async request(method, payload) {
      calls.push([method, payload]);
      const code = failing[method];
      if (code !== undefined) throw new RexError(code, "boom");
      if (method === "session.list") {
        return { sessions: Object.keys(views).map((session_id) => ({ session_id, label: "" })) };
      }
      if (method === "session.view") {
        const found = views[(payload as { session_id: string }).session_id];
        if (found === undefined) throw new RexError("session_not_found", "gone");
        return found;
      }
      return answers[method];
    },
  };
  return { requester, calls };
}

const clients = { clients: [client("app", "app", "unix")] };
const other: SessionView = {
  windows: [{ window_id: "w9", layers: [{ kind: "tiled", blocks: [{ block_id: "b9" }] }] }],
};

describe("RexPress", () => {
  it("finds the block's session, focuses it, then selects its window and opens Rex", async () => {
    const { requester, calls } = fake({ "client.list": clients }, {}, { s: view, t: other });
    const opened: string[] = [];
    const press = new RexPress(requester, async (id) => {
      opened.push(id);
      return true;
    });

    await press.focus("b9");
    const report = await press.raise();

    expect(calls.map(([method]) => method)).toEqual([
      "session.list",
      "session.view",
      "session.view",
      "session.focus_block",
      "client.list",
      "client.perform",
    ]);
    expect(calls[3]?.[1]).toEqual({ session_id: "t", block_id: "b9" });
    expect(calls[5]?.[1]).toEqual(selectPayload("app", "t", "w9"));
    expect(opened).toEqual([REX_BUNDLE_ID]);
    expect(report).toEqual({ select: "selected", selectError: undefined, opened: true });
  });

  it("skips a session destroyed while it is read", async () => {
    const { requester, calls } = fake({ "client.list": clients }, {}, { s: view });
    // `gone` is listed but answers session_not_found.
    const listed: Requester = {
      async request(method, payload) {
        if (method === "session.list") {
          return { sessions: [{ session_id: "gone" }, { session_id: "s" }] };
        }
        return requester.request(method, payload);
      },
    };
    const press = new RexPress(listed, async () => true);
    await press.focus("b2");
    await press.raise();
    expect(calls.at(-1)?.[1]).toEqual(selectPayload("app", "s", "w2"));
  });

  it("finds the block even when an unrelated session fails to read", async () => {
    const { requester, calls } = fake({ "client.list": clients }, {}, { s: view, t: other });
    const flaky: Requester = {
      async request(method, payload) {
        if (method === "session.view" && (payload as { session_id: string }).session_id === "s") {
          throw new RexError("timeout", "no answer");
        }
        return requester.request(method, payload);
      },
    };
    await new RexPress(flaky, async () => true).focus("b9");
    expect(calls.find(([m]) => m === "session.focus_block")?.[1]).toEqual({
      session_id: "t",
      block_id: "b9",
    });
  });

  it("rejects with the read failure when no session holds the block", async () => {
    const { requester } = fake({}, { "session.view": "timeout" });
    await expect(new RexPress(requester, async () => true).focus("b1")).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("rejects the focus for a block that is gone, and then only opens Rex", async () => {
    const { requester, calls } = fake({ "client.list": clients });
    let opened = 0;
    const press = new RexPress(requester, async () => {
      opened += 1;
      return true;
    });

    await expect(press.focus("gone")).rejects.toMatchObject({ code: "not_found" });
    const report = await press.raise();

    expect(calls.map(([method]) => method)).not.toContain("session.focus_block");
    expect(calls.map(([method]) => method)).not.toContain("client.perform");
    expect(report.select).toBe("skipped");
    expect(opened).toBe(1);
  });

  it("rejects the focus when the server says not_found", async () => {
    const { requester } = fake({}, { "session.focus_block": "not_found" });
    await expect(new RexPress(requester, async () => true).focus("b1")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("spends the aim on one raise only", async () => {
    const { requester, calls } = fake({ "client.list": clients });
    const press = new RexPress(requester, async () => true);
    await press.focus("b1");
    await press.raise();
    await press.raise();
    const performs = calls.filter(([method]) => method === "client.perform");
    expect(performs.map(([, payload]) => payload)).toEqual([selectPayload("app", "s", "w1")]);
  });

  it("skips the select with no app client and still opens Rex", async () => {
    const { requester, calls } = fake({ "client.list": { clients: [] } });
    let opened = 0;
    const press = new RexPress(requester, async () => {
      opened += 1;
      return true;
    });
    await press.focus("b1");
    const report = await press.raise();
    expect(report.select).toBe("skipped");
    expect(opened).toBe(1);
    expect(calls.map(([method]) => method)).not.toContain("client.perform");
  });

  it("with nothing focused, only opens Rex: no request, nothing to alert on", async () => {
    const { requester, calls } = fake({ "client.list": clients });
    let opened = 0;
    const press = new RexPress(requester, async () => {
      opened += 1;
      return true;
    });
    const report = await press.raise();
    expect(describePress(report)).toBeNull();
    expect(opened).toBe(1);
    expect(calls).toEqual([]);
  });

  it("reports a failed select and still opens Rex", async () => {
    const { requester } = fake(
      { "client.list": clients },
      { "client.perform": "client_unavailable" },
    );
    let opened = 0;
    const press = new RexPress(requester, async () => {
      opened += 1;
      return true;
    });
    await press.focus("b1");
    const report = await press.raise();
    expect(report).toMatchObject({
      select: "failed",
      selectError: "client_unavailable",
      opened: true,
    });
    expect(opened).toBe(1);
    expect(describePress(report)).toContain("client_unavailable");
  });

  it("reports a failed open", async () => {
    const { requester } = fake({ "client.list": clients });
    const report = await new RexPress(requester, async () => false).raise();
    expect(report.opened).toBe(false);
    expect(describePress(report)).not.toBeNull();
  });
});
