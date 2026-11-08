import { describe, expect, it } from "vitest";

import { rexSocketPath } from "./session.js";

describe("rexSocketPath", () => {
  it("derives the socket from the home directory it is given", () => {
    expect(rexSocketPath("/Users/dev")).toBe(
      "/Users/dev/Library/Application Support/rex/server.sock",
    );
  });
});
