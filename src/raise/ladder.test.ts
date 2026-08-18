import { describe, expect, it, vi } from "vitest";

import type { Aerospace } from "./aerospace.js";
import { type RaiseWorld, raiseLadder } from "./ladder.js";

const NONCE = "sd-herdr raise default #3";

/** A window manager that lists one window, carrying whatever title it is given. */
function windowManager(options: {
  installed: boolean;
  title?: string;
  focusCode?: number;
}): Aerospace {
  return {
    binary: options.installed ? "/opt/homebrew/bin/aerospace" : null,
    run: (argv) =>
      Promise.resolve(
        argv[0] === "list-windows"
          ? { code: 0, stdout: `4242 ${options.title ?? "a window of no interest"}\n` }
          : { code: options.focusCode ?? 0, stdout: "" },
      ),
    wait: () => Promise.resolve(),
    log: vi.fn(),
  };
}

function world(over: Partial<RaiseWorld> = {}): RaiseWorld {
  return {
    windowManager: windowManager({ installed: false }),
    hostApp: () => Promise.resolve({ bundleId: "com.mitchellh.ghostty", source: "discovered" }),
    appleScript: () => Promise.resolve("raised"),
    activate: () => Promise.resolve(true),
    log: vi.fn(),
    ...over,
  };
}

describe("the raise ladder", () => {
  it("stops at the first rung that raises exactly", async () => {
    const applescript = vi.fn(() => Promise.resolve("raised" as const));
    const activate = vi.fn(() => Promise.resolve(true));
    const report = await raiseLadder(
      NONCE,
      world({
        windowManager: windowManager({ installed: true, title: `ghostty — ${NONCE}` }),
        appleScript: applescript,
        activate,
      }),
    );
    expect(report.outcome).toBe("raised");
    expect(report.rung).toBe("window-manager");
    expect(applescript).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  it("declines under a window manager whose nonce simply missed", async () => {
    // The carve-out. `open -b` here is deterministically wrong: it fronts the
    // window on the workspace the user is already looking at, which reads as
    // "the button did nothing" while reporting success.
    const activate = vi.fn(() => Promise.resolve(true));
    const report = await raiseLadder(
      NONCE,
      world({ windowManager: windowManager({ installed: true, title: "someone else" }), activate }),
    );
    expect(report.outcome).toBe("declined");
    expect(activate).not.toHaveBeenCalled();
  });

  it("sends no Apple Event at all on a machine with a window manager", async () => {
    // The whole reason rung 1 is first: an AeroSpace user is never shown an
    // Automation dialog by this plugin, on any press, in any outcome.
    const appleScript = vi.fn(() => Promise.resolve("raised" as const));
    const hostApp = vi.fn(() => Promise.resolve(null));
    for (const title of [`ghostty — ${NONCE}`, "someone else"]) {
      await raiseLadder(
        NONCE,
        world({ windowManager: windowManager({ installed: true, title }), appleScript, hostApp }),
      );
    }
    expect(appleScript).not.toHaveBeenCalled();
    expect(hostApp).not.toHaveBeenCalled();
  });

  it("also declines when the window manager is installed but not answering", async () => {
    // Installed is not running. A non-zero exit still means a tiler may be
    // managing these windows, so the carve-out holds.
    const report = await raiseLadder(
      NONCE,
      world({
        windowManager: windowManager({ installed: true, title: `x — ${NONCE}`, focusCode: 1 }),
      }),
    );
    expect(report.outcome).toBe("declined");
  });

  it("scripts the host application when there is no window manager", async () => {
    const report = await raiseLadder(NONCE, world());
    expect(report).toEqual({
      outcome: "raised",
      rung: "applescript",
      detail: "",
      usedConfiguredHostApp: false,
    });
  });

  it("reaches open -b when the terminal cannot be window-targeted", async () => {
    // WezTerm: no window-targeting script exists, so the app-level raise is the
    // best there is — and it is honestly reported as not exact.
    const report = await raiseLadder(
      NONCE,
      world({ appleScript: () => Promise.resolve("unsupported") }),
    );
    expect(report.outcome).toBe("activated");
    expect(report.rung).toBe("open");
  });

  it("reaches open -b after a denial rather than retrying the script", async () => {
    const appleScript = vi.fn(() => Promise.resolve("denied" as const));
    const report = await raiseLadder(NONCE, world({ appleScript }));
    expect(appleScript).toHaveBeenCalledTimes(1);
    expect(report.outcome).toBe("activated");
  });

  it("declines when nothing can name the host application", async () => {
    const activate = vi.fn(() => Promise.resolve(true));
    const report = await raiseLadder(
      NONCE,
      world({ hostApp: () => Promise.resolve(null), activate }),
    );
    expect(report.outcome).toBe("declined");
    expect(report.rung).toBe("none");
    expect(report.detail).toContain("hostAppBundleId");
    expect(activate).not.toHaveBeenCalled();
  });

  it("declines when even open -b cannot activate the application", async () => {
    const report = await raiseLadder(
      NONCE,
      world({
        appleScript: () => Promise.resolve("unsupported"),
        activate: () => Promise.resolve(false),
      }),
    );
    expect(report.outcome).toBe("declined");
    expect(report.rung).toBe("open");
  });

  it("says when it used the configured host app rather than discovering one", async () => {
    // A silent permanent fallback is how a broken walk goes unnoticed for
    // months, so it is reported even on an exact raise.
    const report = await raiseLadder(
      NONCE,
      world({
        hostApp: () => Promise.resolve({ bundleId: "com.apple.Terminal", source: "setting" }),
      }),
    );
    expect(report).toMatchObject({ outcome: "raised", usedConfiguredHostApp: true });
  });
});
