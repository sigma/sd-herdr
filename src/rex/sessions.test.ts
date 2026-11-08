import { describe, expect, it } from "vitest";

import { RexError } from "./client.js";
import { decodeSessions } from "./sessions.js";

describe("decodeSessions", () => {
  it("keeps the id, and drops entries with no id", () => {
    expect(
      decodeSessions({ sessions: [{ session_id: "session:a", label: "A" }, { label: "x" }, null] }),
    ).toEqual([{ session_id: "session:a" }]);
  });

  it("rejects a payload with no list", () => {
    expect(() => decodeSessions({})).toThrow(RexError);
  });
});
