import { describe, expect, it, vi } from "vitest";

import {
  clientPids,
  type Discovery,
  discoverHostApp,
  processTree,
  topAncestor,
} from "./hostapp.js";

const SOCK = "/Users/dev/.config/herdr/herdr-client.sock";

/**
 * `lsof -U -F pcdn` as it comes off a live machine, trimmed to the three
 * records that matter: the server's listening socket, its accepted end, and the
 * client's connected end pointing back at that end's device.
 *
 * Verbatim shape from `docs/research/terminal-window-discovery.md` §1.2 —
 * records inherit the last `p` seen, and a connected peer renders as `->0x…`.
 */
const LSOF = [
  "p59456",
  "cherdr",
  "f5",
  "d0xa8f37b4fd9f74edf",
  "n->0x8cecf13827963c8f",
  "p59457",
  "cherdr",
  "f9",
  "d0xbf79beb3c6e48fd0",
  `n${SOCK}`,
  "f10",
  "d0x8cecf13827963c8f",
  `n${SOCK}`,
].join("\n");

describe("clientPids", () => {
  it("finds the connected client, not the server that listens for it", () => {
    // Both herdr sockets are listened on by the *server*, so peer-pid-of-our-
    // own-connection returns the daemon. The correlation is what gets past that.
    expect(clientPids(LSOF, SOCK)).toEqual([59456]);
  });

  it("finds nothing when no client is attached", () => {
    const detached = [
      "p59457",
      "cherdr",
      "f9",
      "d0xbf79beb3c6e48fd0",
      `n${SOCK}`,
      "f10",
      "d0x8cecf13827963c8f",
      `n${SOCK}`,
    ].join("\n");
    expect(clientPids(detached, SOCK)).toEqual([]);
  });

  it("ignores every other unix socket on the machine", () => {
    // `lsof -U` lists every unix socket there is, and a busy machine has
    // hundreds. Correlation is by device, so a neighbour's connected end is not
    // a candidate however close to herdr's rows it happens to be printed.
    const noisy = `p900\ncnotifyd\nf3\nd0xdeadbeefdeadbeef\nn->0xfeedfacefeedface\n${LSOF}`;
    expect(clientPids(noisy, SOCK)).toEqual([59456]);
  });

  it("answers about the socket it was asked about, not about herdr in general", () => {
    // Each named session has its own socket pair, so the correlation is
    // per-session: a second button watching `work` must not raise `default`'s
    // terminal.
    expect(clientPids(LSOF, "/Users/dev/.config/herdr/sessions/work/herdr-client.sock")).toEqual(
      [],
    );
  });

  it("survives lsof rows that carry no name at all", () => {
    expect(clientPids("p1\nc launchd\nf1\nd0x1\n", SOCK)).toEqual([]);
  });

  it("does not let one file record inherit the device of the one before it", () => {
    // `f` opens a new record. A pipe or a socket lsof reports without a `d`
    // would otherwise borrow its predecessor's device and be counted as a
    // connection to a socket it never touched.
    const inherited = [
      "p900",
      "cnotifyd",
      "f3",
      "d0x8cecf13827963c8f",
      "n/some/other.sock",
      "f4",
      "n->0x8cecf13827963c8f",
      `p59457\ncherdr\nf10\nd0x8cecf13827963c8f\nn${SOCK}`,
    ].join("\n");
    expect(clientPids(inherited, SOCK)).toEqual([]);
  });
});

describe("topAncestor", () => {
  /** The verified chain: client < fish < login < ghostty < launchd. */
  const PS = ["59456 1553", "1553 1552", "1552 1549", "1549 1", "  887     1"].join("\n");

  it("walks to the process launchd started, which is the application", () => {
    expect(topAncestor(processTree(PS), 59456)).toBe(1549);
  });

  it("does not care what the executable path looks like", () => {
    // A Nix-packaged WezTerm keeps its binary directly inside WezTerm.app/,
    // not under Contents/MacOS/, so a path-shape test would miss it. The ppid
    // is the termination condition and the path is never read.
    expect(topAncestor(processTree("65821 1"), 65821)).toBe(65821);
  });

  it("gives up on a pid it cannot find, rather than guessing", () => {
    expect(topAncestor(processTree(PS), 4242)).toBeNull();
  });

  it("gives up on a chain that loops", () => {
    expect(topAncestor(processTree("10 11\n11 10"), 10)).toBeNull();
  });
});

describe("discoverHostApp", () => {
  const world = (over: Partial<Discovery> = {}): Discovery => ({
    unixSockets: () => Promise.resolve(LSOF),
    processTree: () => Promise.resolve("59456 1553\n1553 1552\n1552 1549\n1549 1"),
    bundleIdOf: (pid) => Promise.resolve(pid === 1549 ? "com.mitchellh.ghostty" : null),
    log: vi.fn(),
    ...over,
  });

  it("names the application at the top of the client's process chain", async () => {
    expect(await discoverHostApp(SOCK, undefined, world())).toEqual({
      bundleId: "com.mitchellh.ghostty",
      source: "discovered",
    });
  });

  it("prefers the walk over the configured fallback", async () => {
    expect(await discoverHostApp(SOCK, "com.apple.Terminal", world())).toEqual({
      bundleId: "com.mitchellh.ghostty",
      source: "discovered",
    });
  });

  it("falls back to hostAppBundleId when the chain is not a GUI app", async () => {
    // The tmux and zellij case: the chain terminates at a daemonised
    // multiplexer, and System Events answers -1719.
    const muxed = world({ bundleIdOf: () => Promise.resolve(null) });
    expect(await discoverHostApp(SOCK, "com.mitchellh.ghostty", muxed)).toEqual({
      bundleId: "com.mitchellh.ghostty",
      source: "setting",
    });
  });

  it("says so in the log when it cannot name anything and nothing is configured", async () => {
    const blind = world({ unixSockets: () => Promise.resolve(null) });
    expect(await discoverHostApp(SOCK, undefined, blind)).toBeNull();
    expect(blind.log).toHaveBeenCalledWith(expect.stringContaining("hostAppBundleId"));
  });

  it("treats an empty setting as no setting", async () => {
    const muxed = world({ bundleIdOf: () => Promise.resolve(null) });
    expect(await discoverHostApp(SOCK, "", muxed)).toBeNull();
  });

  it("reports a detached session rather than walking a pid it does not have", async () => {
    const detached = world({ unixSockets: () => Promise.resolve("") });
    expect(await discoverHostApp(SOCK, undefined, detached)).toBeNull();
    expect(detached.log).toHaveBeenCalledWith(expect.stringContaining("nothing is connected"));
  });
});
