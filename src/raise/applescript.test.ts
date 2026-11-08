import { describe, expect, it, vi } from "vitest";

import { errorCode, type Osascript, raiseByAppleScript, scriptFor } from "./applescript.js";

const NONCE = "sd-mux raise default #7";

describe("errorCode", () => {
  it("reads the AppleEvent code osascript prints on a failure", () => {
    expect(
      errorCode("execution error: Ghostty got an error: Can't get index of window 1. (-1728)\n"),
    ).toBe(-1728);
  });

  it("reads a denial, which is the code that decides the rung", () => {
    expect(
      errorCode("execution error: Not authorized to send Apple events to Terminal. (-1743)\n"),
    ).toBe(-1743);
  });

  it("is positional, so a localised or app-authored message changes nothing", () => {
    // The sentence around the number is written by the app and translated by
    // the OS; the number is the platform's. Keying on the text would make the
    // rung behave differently in French.
    expect(errorCode("erreur d'exécution : Impossible d'obtenir la fenêtre 1. (-1728)")).toBe(
      -1728,
    );
  });

  it("finds nothing in output that carries no code", () => {
    expect(errorCode("")).toBeNull();
    expect(errorCode("execution error: something went wrong")).toBeNull();
    expect(errorCode("execution error: (not a number)")).toBeNull();
  });
});

describe("scriptFor", () => {
  it("targets the nonce-carrying window, never the front one", () => {
    // An app-level raise is rung 3's job and a different promise. A rung-2
    // script that settled for the front window would report an exact raise it
    // did not perform.
    expect(scriptFor("com.mitchellh.ghostty", NONCE)).toContain(
      'first window whose name contains "sd-mux raise default #7"',
    );
  });

  it("has no script for a terminal that answers no window queries", () => {
    // The default branch is a real case, not a safety net: WezTerm answers
    // -1728 to every window query and cannot be window-targeted at all.
    expect(scriptFor("com.github.wez.wezterm", NONCE)).toBeNull();
  });

  it("escapes a session name that would otherwise end the string literal", () => {
    const script = scriptFor("com.mitchellh.ghostty", 'sd-mux raise say "hi" #1');
    expect(script).toContain('\\"hi\\"');
  });
});

describe("raiseByAppleScript", () => {
  const osascript = (over: Partial<Osascript> = {}): Osascript => ({
    run: () => Promise.resolve({ code: 0, stderr: "" }),
    log: vi.fn(),
    ...over,
  });

  const failing = (stderr: string) =>
    osascript({ run: () => Promise.resolve({ code: 1, stderr }) });

  it("raises when the script does", async () => {
    expect(await raiseByAppleScript("com.mitchellh.ghostty", NONCE, osascript())).toBe("raised");
  });

  it("does not even run for a bundle id the table cannot target", async () => {
    const osa = osascript({ run: vi.fn() });
    expect(await raiseByAppleScript("com.github.wez.wezterm", NONCE, osa)).toBe("unsupported");
    expect(osa.run).not.toHaveBeenCalled();
  });

  it("reads a denial as denied, by code rather than by message", async () => {
    const osa = failing("execution error: Not authorized to send Apple events. (-1743)");
    expect(await raiseByAppleScript("com.mitchellh.ghostty", NONCE, osa)).toBe("denied");
  });

  it("says where a denial has to be fixed, because the plugin cannot re-ask", async () => {
    // One prompt per (client, target) pair, ever: after a refusal every attempt
    // returns -1743 and macOS never re-prompts.
    const osa = failing("execution error: Not authorized to send Apple events. (-1743)");
    await raiseByAppleScript("com.mitchellh.ghostty", NONCE, osa);
    expect(osa.log).toHaveBeenCalledWith(expect.stringContaining("will not ask again"));
  });

  it("asks exactly once and never retries after a denial", async () => {
    const run = vi.fn(() => Promise.resolve({ code: 1, stderr: "execution error: nope. (-1743)" }));
    await raiseByAppleScript("com.mitchellh.ghostty", NONCE, osascript({ run }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps never-asked apart from denied, which is a different sentence to the user", async () => {
    // -1744 is errAEEventWouldRequireUserConsent: the grant has not been
    // refused, only never requested. Telling the user macOS will never ask
    // again would send them to fix something that is not broken.
    const osa = failing("execution error: consent required. (-1744)");
    expect(await raiseByAppleScript("com.mitchellh.ghostty", NONCE, osa)).toBe("ungranted");
    expect(osa.log).not.toHaveBeenCalledWith(expect.stringContaining("will not ask again"));
  });

  it("reads an unsupported window query as unsupported", async () => {
    const osa = failing("execution error: Can't get index of window 1. (-1728)");
    expect(await raiseByAppleScript("com.mitchellh.ghostty", NONCE, osa)).toBe("unsupported");
  });

  it("reads a target that is not running as unavailable", async () => {
    const osa = failing("execution error: Application isn't running. (-600)");
    expect(await raiseByAppleScript("com.mitchellh.ghostty", NONCE, osa)).toBe("unavailable");
  });

  it("reads an unrecognised failure as a miss, rather than as anything it knows", async () => {
    const osa = failing("execution error: something new. (-42)");
    expect(await raiseByAppleScript("com.mitchellh.ghostty", NONCE, osa)).toBe("missed");
  });
});
