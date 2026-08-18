import { describe, expect, it } from "vitest";

import { clientSocketPathFor, socketPathFor } from "./session.js";

const HOME = "/Users/dev";

describe("socketPathFor", () => {
  it("puts the default session's socket straight in the config directory", () => {
    // Verified against a live install: `herdr session list --json` reports
    // exactly this path for `default`.
    expect(socketPathFor("default", {}, HOME)).toBe("/Users/dev/.config/herdr/herdr.sock");
  });

  it("puts a named session under sessions/<name>/", () => {
    expect(socketPathFor("work", {}, HOME)).toBe(
      "/Users/dev/.config/herdr/sessions/work/herdr.sock",
    );
  });

  it("honours XDG_CONFIG_HOME when there is one to honour", () => {
    const env = { XDG_CONFIG_HOME: "/Users/dev/cfg" };
    expect(socketPathFor("default", env, HOME)).toBe("/Users/dev/cfg/herdr/herdr.sock");
    expect(socketPathFor("work", env, HOME)).toBe("/Users/dev/cfg/herdr/sessions/work/herdr.sock");
  });

  it("ignores an XDG_CONFIG_HOME set to nothing", () => {
    // An exported-but-empty variable means "unset" to every shell the user
    // might have; taking it literally would resolve the path against `/`.
    expect(socketPathFor("default", { XDG_CONFIG_HOME: "" }, HOME)).toBe(
      "/Users/dev/.config/herdr/herdr.sock",
    );
  });

  it("names the client socket beside it, which is what the raise walk correlates on", () => {
    // Verified on a live install: `herdr-client.sock` sits next to `herdr.sock`
    // in the same directory. The plugin never speaks that protocol — it needs
    // the path only as a name to match in `lsof` output.
    expect(clientSocketPathFor("default", {}, HOME)).toBe(
      "/Users/dev/.config/herdr/herdr-client.sock",
    );
    expect(clientSocketPathFor("work", {}, HOME)).toBe(
      "/Users/dev/.config/herdr/sessions/work/herdr-client.sock",
    );
  });

  it("is total: a session that does not exist still yields a path", () => {
    // There is no "not found" here by design. Whether anything answers on the
    // path is the socket client's question, and its answer is the same grey.
    expect(socketPathFor("no-such-session", {}, HOME)).toBe(
      "/Users/dev/.config/herdr/sessions/no-such-session/herdr.sock",
    );
  });
});
