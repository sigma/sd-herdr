import { describe, expect, it } from "vitest";

import { AEROSPACE_CANDIDATES, type Aerospace, findAerospace, raiseByNonce } from "./aerospace.js";

const NONCE = "sd-herdr raise default #1";

/**
 * A world where `aerospace` answers whatever the test says, and where the
 * 60 ms re-query costs nothing: the wait is recorded rather than slept.
 */
function world(replies: readonly { code: number; stdout: string }[]) {
  const argvs: string[][] = [];
  const waits: number[] = [];
  const logs: string[] = [];
  let next = 0;

  const aerospace: Aerospace = {
    binary: "/opt/homebrew/bin/aerospace",
    async run(argv) {
      argvs.push([...argv]);
      return replies[Math.min(next++, replies.length - 1)] ?? { code: 0, stdout: "" };
    },
    wait: async (ms) => {
      waits.push(ms);
    },
    log: (message) => {
      logs.push(message);
    },
  };

  return {
    aerospace,
    argvs,
    waits,
    logs,
    /** Just the window ids that were actually focused. */
    focused: () => argvs.filter((a) => a[0] === "focus").map((a) => a.at(-1)),
    listings: () => argvs.filter((a) => a[0] === "list-windows").length,
  };
}

const listing = (...lines: string[]) => ({ code: 0, stdout: `${lines.join("\n")}\n` });

describe("findAerospace", () => {
  it("probes absolute paths, because a plugin does not inherit the shell PATH", () => {
    // Measured: the plugin's PATH is launchd's /usr/bin:/bin:/usr/sbin:/sbin,
    // so a bare `aerospace` is ENOENT however the user installed it.
    expect(AEROSPACE_CANDIDATES.every((path) => path.startsWith("/"))).toBe(true);
  });

  it("takes the first candidate that exists", () => {
    const found = findAerospace((path) => path === AEROSPACE_CANDIDATES[1], AEROSPACE_CANDIDATES);
    expect(found).toBe(AEROSPACE_CANDIDATES[1]);
  });

  it("is null when no window manager is installed", () => {
    expect(findAerospace(() => false, AEROSPACE_CANDIDATES)).toBeNull();
  });
});

describe("raiseByNonce", () => {
  it("raises the one window carrying the nonce", async () => {
    const w = world([listing("206 herdr", `28653 ${NONCE}`)]);

    expect(await raiseByNonce(NONCE, w.aerospace)).toBe("raised");
    expect(w.focused()).toEqual(["28653"]);
  });

  it("reads a title with spaces in it, which every nonce has", async () => {
    const w = world([listing(`28653 ${NONCE}`)]);

    await raiseByNonce(NONCE, w.aerospace);

    expect(w.focused()).toEqual(["28653"]);
  });

  it("re-queries exactly once when the nonce has not landed yet", async () => {
    // The nonce reaches a window manager's list in 12–89 ms, so it is normally
    // already there. One re-query covers the tail; a poll loop would hold the
    // press open for a window that is never coming.
    const w = world([listing("206 herdr"), listing(`28653 ${NONCE}`)]);

    expect(await raiseByNonce(NONCE, w.aerospace)).toBe("raised");
    expect(w.listings()).toBe(2);
    expect(w.waits).toEqual([60]);
  });

  it("declines rather than raising the wrong window when the nonce never lands", async () => {
    // Under a tiling WM an app-level raise is deterministically wrong: it
    // fronts the window on the workspace the user is already looking at.
    const w = world([listing("206 herdr")]);

    expect(await raiseByNonce(NONCE, w.aerospace)).toBe("declined");
    expect(w.listings()).toBe(2);
    expect(w.focused()).toEqual([]);
  });

  it("takes the first of several matches, and says so", async () => {
    const w = world([listing(`28653 ${NONCE}`, `28999 ${NONCE}`)]);

    expect(await raiseByNonce(NONCE, w.aerospace)).toBe("raised");
    expect(w.focused()).toEqual(["28653"]);
    expect(w.logs.join(" ")).toMatch(/2/);
  });

  it("falls through when aerospace is installed but not running", async () => {
    // Installed ≠ running: a non-zero exit is a fall-through, not a crash.
    const w = world([{ code: 1, stdout: "" }]);

    expect(await raiseByNonce(NONCE, w.aerospace)).toBe("declined");
    expect(w.listings()).toBe(1);
  });

  it("falls through when the window went away between listing and focusing", async () => {
    const w = world([listing(`28653 ${NONCE}`), { code: 2, stdout: "" }]);

    expect(await raiseByNonce(NONCE, w.aerospace)).toBe("declined");
  });

  it("does nothing at all when there is no aerospace to run", async () => {
    const w = world([]);
    const missing: Aerospace = { ...w.aerospace, binary: null };

    expect(await raiseByNonce(NONCE, missing)).toBe("declined");
    expect(w.argvs).toEqual([]);
  });
});
