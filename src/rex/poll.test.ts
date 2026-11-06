import { describe, expect, it } from "vitest";
import { rexWire } from "../testing/rex-fixtures.js";
import { type Requester, RexError } from "./client.js";
import { decodeReport, decodeView, pollSession, terminalBlockIds } from "./poll.js";

const S = "session:fixture";

/** A server stand-in that answers from a fixture and records what it was asked. */
function serverFor(
  name: Parameters<typeof rexWire>[0],
  fail?: (method: string) => RexError | null,
) {
  const { view, reports } = rexWire(name);
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const client: Requester = {
    async request(method, payload) {
      calls.push({ method, payload: payload as Record<string, unknown> });
      const failure = fail?.(method);
      if (failure) throw failure;
      if (method === "session.view") return view;
      const report = reports.get((payload as { block_id: string }).block_id);
      if (method.endsWith(".program_status")) return { records: report?.records ?? [] };
      if (method.endsWith(".title")) return { title: report?.title ?? "" };
      throw new Error(`unexpected ${method}`);
    },
  };
  return { client, calls };
}

describe("pollSession", () => {
  it("views the session, then asks each terminal block for its status and title", async () => {
    const { client, calls } = serverFor("two-windows");
    const snapshot = await pollSession(client, S);

    expect(calls[0]).toEqual({ method: "session.view", payload: { session_id: S } });
    const rest = calls.slice(1).map((c) => `${c.method} ${c.payload.block_id}`);
    expect(rest.sort()).toEqual(
      ["a1", "a2", "b1"]
        .flatMap((b) => [
          `com.superlogical.terminal.program_status block:${b}`,
          `com.superlogical.terminal.title block:${b}`,
        ])
        .sort(),
    );
    for (const call of calls.slice(1)) expect(call.payload.session_id).toBe(S);
    expect(snapshot.agents.map((a) => a.paneId)).toEqual(["block:a1", "block:b1"]);
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

  it("rejects the snapshot when any call fails", async () => {
    const { client } = serverFor("two-windows", (m) =>
      m.endsWith(".title") ? new RexError("not_found", "block not found") : null,
    );
    await expect(pollSession(client, S)).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects with session_not_found for a destroyed session, which the core renders grey", async () => {
    const { client } = serverFor("two-windows", () => new RexError("session_not_found", "gone"));
    await expect(pollSession(client, S)).rejects.toMatchObject({ code: "session_not_found" });
  });

  it("rejects without asking anything when no session is configured", async () => {
    const { client, calls } = serverFor("two-windows");
    await expect(pollSession(client, "")).rejects.toMatchObject({ code: "no_session" });
    expect(calls).toHaveLength(0);
  });
});

describe("decoding", () => {
  it("rejects a view that is not an object", () => {
    expect(() => decodeView(null)).toThrow(RexError);
  });

  it("rejects a status or title result of the wrong shape", () => {
    expect(() => decodeReport({}, { title: "" })).toThrow(/records/);
    expect(() => decodeReport({ records: [] }, {})).toThrow(/title/);
    expect(decodeReport({ records: [] }, { title: "t" })).toEqual({ records: [], title: "t" });
  });
});
