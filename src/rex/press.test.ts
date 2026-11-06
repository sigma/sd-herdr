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
  it("names the window when there is one", () => {
    expect(selectPayload("c", "s", "w1")).toEqual({
      client_id: "c",
      action: "session.select",
      args: { session_id: "s", window_id: "w1" },
      timeout_ms: SELECT_TIMEOUT_MS,
    });
  });

  it("leaves the window out when there is none", () => {
    expect(selectPayload("c", "s", null).args).toEqual({ session_id: "s" });
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

/** A requester that records calls and answers from a table, failing the methods it is told to. */
function fake(answers: Record<string, unknown>, failing: Record<string, string> = {}) {
  const calls: Array<[string, object]> = [];
  const requester: Requester = {
    async request(method, payload) {
      calls.push([method, payload]);
      const code = failing[method];
      if (code !== undefined) throw new RexError(code, "boom");
      return answers[method];
    },
  };
  return { requester, calls };
}

const clients = { clients: [client("app", "app", "unix")] };

describe("RexPress", () => {
  it("focuses the block, then selects its window and opens Rex", async () => {
    const { requester, calls } = fake({ "session.view": view, "client.list": clients });
    const opened: string[] = [];
    const press = new RexPress(requester, async (id) => {
      opened.push(id);
      return true;
    });

    await press.focus("s", "b2");
    const report = await press.raise("s");

    expect(calls.map(([method]) => method)).toEqual([
      "session.view",
      "session.focus_block",
      "client.list",
      "client.perform",
    ]);
    expect(calls[1]?.[1]).toEqual({ session_id: "s", block_id: "b2" });
    expect(calls[3]?.[1]).toEqual(selectPayload("app", "s", "w2"));
    expect(opened).toEqual([REX_BUNDLE_ID]);
    expect(report).toEqual({ select: "selected", selectError: undefined, opened: true });
  });

  it("rejects the focus for a block that is gone, and then selects without a window", async () => {
    const { requester, calls } = fake({ "session.view": view, "client.list": clients });
    const press = new RexPress(requester, async () => true);

    await expect(press.focus("s", "gone")).rejects.toMatchObject({ code: "not_found" });
    await press.raise("s");

    expect(calls.map(([method]) => method)).not.toContain("session.focus_block");
    expect(calls.at(-1)?.[1]).toEqual(selectPayload("app", "s", null));
  });

  it("rejects the focus when the server says not_found", async () => {
    const { requester } = fake({ "session.view": view }, { "session.focus_block": "not_found" });
    await expect(new RexPress(requester, async () => true).focus("s", "b1")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("spends the window on one raise only", async () => {
    const { requester, calls } = fake({ "session.view": view, "client.list": clients });
    const press = new RexPress(requester, async () => true);
    await press.focus("s", "b1");
    await press.raise("s");
    await press.raise("s");
    const performs = calls.filter(([method]) => method === "client.perform");
    expect(performs.map(([, payload]) => payload)).toEqual([
      selectPayload("app", "s", "w1"),
      selectPayload("app", "s", null),
    ]);
  });

  it("skips the select with no app client and still opens Rex", async () => {
    const { requester, calls } = fake({ "client.list": { clients: [] } });
    let opened = 0;
    const press = new RexPress(requester, async () => {
      opened += 1;
      return true;
    });
    const report = await press.raise("s");
    expect(report.select).toBe("skipped");
    expect(opened).toBe(1);
    expect(calls.map(([method]) => method)).toEqual(["client.list"]);
  });

  it("with no session chosen, only opens Rex: no request, nothing to alert on", async () => {
    const { requester, calls } = fake({ "client.list": clients });
    let opened = 0;
    const press = new RexPress(requester, async () => {
      opened += 1;
      return true;
    });
    const report = await press.raise("");
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
    const report = await press.raise("s");
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
    const report = await new RexPress(requester, async () => false).raise("s");
    expect(report.opened).toBe(false);
    expect(describePress(report)).not.toBeNull();
  });
});
