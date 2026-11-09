import { describe, expect, it } from "vitest";
import { rexFixture, rexWire } from "../testing/rex-fixtures.js";
import { type Pollable, RexError } from "./client.js";
import { INSTANCE_KEY } from "./convert.js";
import { decodeReport, decodeView, pollServer, terminalBlockIds } from "./poll.js";

type FixtureName = Parameters<typeof rexWire>[0];

/**
 * A server stand-in holding one session per fixture, named `session:<fixture>`,
 * that answers from them and records what it was asked. `fail` may fail any
 * call, given its method, session and block.
 */
function serverFor(
  names: FixtureName | FixtureName[],
  fail?: (method: string, sessionId: unknown, blockId: unknown) => RexError | null,
  instanceId = "inst-1",
) {
  const sessions = new Map(
    (Array.isArray(names) ? names : [names]).map((n) => [`session:${n}`, rexWire(n)]),
  );
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const client: Pollable = {
    async instanceId() {
      return instanceId;
    },
    async request(method, payload) {
      calls.push({ method, payload: payload as Record<string, unknown> });
      const { session_id, block_id } = payload as { session_id?: string; block_id?: string };
      const failure = fail?.(method, session_id, block_id);
      if (failure) throw failure;
      if (method === "session.list") {
        return { sessions: [...sessions.keys()].map((id) => ({ session_id: id, label: "" })) };
      }
      const session = sessions.get(session_id ?? "");
      if (session === undefined) throw new RexError("session_not_found", "no such session");
      if (method === "session.view") return session.view;
      const report = session.reports.get(block_id ?? "");
      if (method.endsWith(".program_status")) return { records: report?.records ?? [] };
      throw new Error(`unexpected ${method}`);
    },
  };
  return { client, calls };
}

describe("pollServer", () => {
  it("lists the sessions, views each, then asks each terminal block for its status", async () => {
    const { client, calls } = serverFor("two-windows");
    const S = "session:two-windows";
    const snapshot = await pollServer(client);

    expect(calls[0]).toEqual({ method: "session.list", payload: {} });
    expect(calls[1]).toEqual({ method: "session.view", payload: { session_id: S } });
    const rest = calls.slice(2).map((c) => `${c.method} ${c.payload.block_id}`);
    expect(rest.sort()).toEqual(
      ["a1", "a2", "b1"].map((b) => `com.superlogical.terminal.program_status block:${b}`),
    );
    for (const call of calls.slice(2)) expect(call.payload.session_id).toBe(S);
    expect(snapshot.agents.map((a) => a.paneId)).toEqual(["block:a1", "block:b1"]);
  });

  it("gathers the agents of every session, each block asked within its own session", async () => {
    const { client, calls } = serverFor(["two-windows", "floating-layer"]);
    const snapshot = await pollServer(client);
    expect(snapshot.agents.map((a) => a.paneId)).toEqual([
      ...rexFixture("two-windows").agents.map((a) => a.paneId),
      ...rexFixture("floating-layer").agents.map((a) => a.paneId),
    ]);
    const asked = calls.filter((c) => c.method.endsWith(".program_status"));
    for (const call of asked) {
      const name = String(call.payload.session_id).slice("session:".length) as FixtureName;
      expect(rexWire(name).reports.has(String(call.payload.block_id))).toBe(true);
    }
  });

  it("skips a session destroyed between the list and its view", async () => {
    const { client } = serverFor(["two-windows", "floating-layer"], (method, session) =>
      method === "session.view" && session === "session:floating-layer"
        ? new RexError("session_not_found", "gone")
        : null,
    );
    expect((await pollServer(client)).agents).toEqual(rexFixture("two-windows").agents);
  });

  it("skips a session destroyed while its blocks are read", async () => {
    const { client } = serverFor(["two-windows", "floating-layer"], (method, session) =>
      method.endsWith(".program_status") && session === "session:floating-layer"
        ? new RexError("session_not_found", "gone")
        : null,
    );
    expect((await pollServer(client)).agents).toEqual(rexFixture("two-windows").agents);
  });

  it("drops a block closed between the view and its report, keeping the rest", async () => {
    const { client } = serverFor("two-windows", (method, _session, block) =>
      method.endsWith(".program_status") && block === "block:b1"
        ? new RexError("not_found", "block not found")
        : null,
    );
    expect((await pollServer(client)).agents.map((a) => a.paneId)).toEqual(["block:a1"]);
  });

  it("rejects when the server cannot be reached", async () => {
    const { client } = serverFor("two-windows");
    const down: Pollable = {
      instanceId: () => Promise.reject(new RexError("connection_closed", "down")),
      request: client.request,
    };
    await expect(pollServer(down)).rejects.toMatchObject({ code: "connection_closed" });
  });

  it("is an empty server, not a failure, with no sessions", async () => {
    const { client } = serverFor([]);
    expect((await pollServer(client)).agents).toEqual([]);
  });

  it("carries the connection's instance_id into the snapshot as the lifetime marker", async () => {
    const { client } = serverFor("two-windows", undefined, "inst-9");
    expect((await pollServer(client)).lifetime).toEqual(new Map([[INSTANCE_KEY, "inst-9"]]));
  });

  it("calls only terminal blocks", () => {
    const { view } = rexWire("two-windows");
    const withBrowser = {
      ...view,
      windows: view.windows?.map((w) => ({
        ...w,
        layers: w.layers?.map((l) => ({
          ...l,
          blocks: [
            ...(l.blocks ?? []),
            { block_id: "block:web", creator_name: "com.example.browser" },
          ],
        })),
      })),
    };
    expect(terminalBlockIds(withBrowser)).not.toContain("block:web");
    expect(terminalBlockIds(withBrowser)).toHaveLength(3);
  });

  it("rejects the snapshot when any other call fails", async () => {
    const { client } = serverFor("two-windows", (m) =>
      m.endsWith(".program_status") ? new RexError("timeout", "no answer") : null,
    );
    await expect(pollServer(client)).rejects.toMatchObject({ code: "timeout" });
  });

  it("rejects when the list fails", async () => {
    const { client } = serverFor("two-windows", (m) =>
      m === "session.list" ? new RexError("internal", "boom") : null,
    );
    await expect(pollServer(client)).rejects.toMatchObject({ code: "internal" });
  });
});

describe("decoding", () => {
  it("rejects a view that is not an object", () => {
    expect(() => decodeView(null)).toThrow(RexError);
  });

  it("rejects a status result of the wrong shape", () => {
    expect(() => decodeReport({})).toThrow(/records/);
    expect(decodeReport({ records: [] })).toEqual({ records: [] });
  });
});
