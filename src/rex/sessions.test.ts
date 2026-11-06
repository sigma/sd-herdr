import { describe, expect, it } from "vitest";

import { RexError } from "./client.js";
import { decodeSessions, listSessions, type SessionList, sessionOptions } from "./sessions.js";

const live = (...sessions: [string, string][]): SessionList => ({
  kind: "live",
  sessions: sessions.map(([session_id, label]) => ({ session_id, label })),
});

describe("sessionOptions", () => {
  it("lists live sessions by label, leaving a stored one selected", () => {
    const options = sessionOptions(live(["session:a", "Work"], ["session:b", "Play"]), "session:b");
    expect(options).toEqual([
      { value: "session:a", text: "Work" },
      { value: "session:b", text: "Play" },
    ]);
  });

  it("keeps a stored session that is gone, shown as missing", () => {
    const options = sessionOptions(live(["session:a", "Work"]), "session:gone");
    expect(options[0]).toEqual({ value: "session:gone", text: "missing session (session:gone)" });
    expect(options.slice(1)).toEqual([{ value: "session:a", text: "Work" }]);
  });

  it("offers a prompt when nothing is stored", () => {
    expect(sessionOptions(live(["session:a", "Work"]), "")[0]).toEqual({
      value: "",
      text: "Choose a session…",
      disabled: true,
    });
    expect(sessionOptions(live(), "")).toEqual([
      { value: "", text: "No Rex sessions", disabled: true },
    ]);
  });

  it("says Rex is not running, and keeps the stored selection", () => {
    expect(sessionOptions({ kind: "down" }, "")).toEqual([
      { value: "", text: "Rex is not running", disabled: true },
    ]);
    expect(sessionOptions({ kind: "down" }, "session:a")).toEqual([
      { value: "session:a", text: "session:a (Rex is not running)" },
    ]);
  });

  it("tells sessions with the same label apart by id", () => {
    const options = sessionOptions(
      live(["session:a", "Work"], ["session:b", "Work"], ["session:c", "Play"]),
      "session:a",
    );
    expect(options.map((o) => o.text)).toEqual(["Work (session:a)", "Work (session:b)", "Play"]);
  });

  it("falls back to the id for a session with no label", () => {
    expect(sessionOptions(live(["session:a", ""]), "session:a")).toEqual([
      { value: "session:a", text: "session:a" },
    ]);
  });
});

describe("decodeSessions", () => {
  it("keeps id and label, and drops entries with no id", () => {
    expect(
      decodeSessions({ sessions: [{ session_id: "session:a", label: "A" }, { label: "x" }, null] }),
    ).toEqual([{ session_id: "session:a", label: "A" }]);
  });

  it("rejects a payload with no list", () => {
    expect(() => decodeSessions({})).toThrow(RexError);
  });
});

describe("listSessions", () => {
  const client = (request: () => Promise<unknown>) => {
    const state = { retained: 0, released: 0 };
    return {
      state,
      client: {
        request,
        retain: () => {
          state.retained += 1;
          return () => {
            state.released += 1;
          };
        },
      },
    };
  };

  it("retains for the listing and releases after", async () => {
    const { client: c, state } = client(async () => ({
      sessions: [{ session_id: "s", label: "S" }],
    }));
    expect(await listSessions(c)).toEqual(live(["s", "S"]));
    expect(state).toEqual({ retained: 1, released: 1 });
  });

  it("reports a failure as down, still releasing", async () => {
    const seen: unknown[] = [];
    const { client: c, state } = client(async () => {
      throw new RexError("closed", "gone");
    });
    expect(await listSessions(c, (e) => seen.push(e))).toEqual({ kind: "down" });
    expect(seen).toHaveLength(1);
    expect(state).toEqual({ retained: 1, released: 1 });
  });
});
