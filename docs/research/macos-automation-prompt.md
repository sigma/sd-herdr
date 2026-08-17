# Does the first-run Automation prompt reach an `LSUIElement` plugin?

Research for [sigma/sd-herdr#11](https://github.com/sigma/sd-herdr/issues/11) (map: #1).
Closes the one bullet [window-raise-multiwindow.md §4](window-raise-multiwindow.md) could not
resolve by execution, and revises its central inference.

**Subject**: macOS `26.5.2` (build `25F84`, darwin 25.5.0), Elgato Stream Deck `7.4.2` (22730),
bundled Node `20.20.0`, Xcode CLT SDK `MacOSX.sdk`.

**Method**: two throwaway ad-hoc-signed `LSUIElement` app bundles with never-before-seen bundle ids
(`dev.yrh.sdprobe.research11`, `…11b`) under `/tmp/sdprobe11`, each launched via LaunchServices so
`ppid == 1`, calling `AEDeterminePermissionToAutomateTarget` **in process** rather than shelling out
to `osascript` — which is the methodological change that unlocked everything below. On-screen TCC UI
was detected with `CGWindowListCopyWindowInfo` (owner names need no Screen Recording grant). The
user's own grants were never reset; the single grant this research created was removed again (§8).

Evidence key: **[V]** verified by execution here, **[D]** documented in a primary source,
**[U]** unverified.

---

## Headline

- **Yes, the prompt appears.** [V] A windowless, Dock-less `LSUIElement` process with `ppid == 1`,
  no `NSApplication` and no run loop, got the system Automation dialog presented on screen. §3.
- **The plugin *can* tell "not yet asked" from "asked and denied".** [V][D] The ticket's assertion
  that `-1743` on the wire is the only signal is **wrong**:
  `AEDeterminePermissionToAutomateTarget(…, askUserIfNeeded: false)` is a silent, ~20 ms, four-way
  oracle — `noErr` / `-1744` / `-1743` / `-600`. §2.
- **#5's null result is explained, and it was a measurement artefact.** [V] From *one* virgin
  bundle, in the *same* process: the in-process permission check said `-1744` (never asked) while a
  shelled-out `/usr/bin/osascript` reached the same target successfully with no prompt. **`osascript`
  is not the caller's TCC subject.** Every probe in #5 went through `osascript`, so none of them
  could ever have provoked a prompt. §5.
- **A Stream Deck plugin has no code identity at all** [V, via SDK survey] — `.sdPlugin` is a plain
  directory with no `Info.plist`, no bundle id, no signature. The TCC subject is
  `com.elgato.StreamDeck`, whose `Info.plist` says, verbatim,
  `NSAppleEventsUsageDescription = "A Stream Deck plugin wants to use AppleScripts."` — Elgato wrote
  the onboarding copy for us. §6.
- **Grants are per (client, target) pair.** [V] Allowing SDProbe11 → Finder left SDProbe11 → Ghostty
  at `-1744`. A user who granted Stream Deck Automation for Spotify has *not* granted it for their
  terminal. §4.
- **For v1 this is tier-2-only and no longer a gate.** With AeroSpace first (#10), the whole question
  applies only to the AppleScript rung. Recommendation: fold into the spec as a caveat, plus one
  cheap human-run probe (§9). §7.

---

## 1. What the primary sources actually say

`AEDeterminePermissionToAutomateTarget` is declared in
`$(xcrun --show-sdk-path)/System/Library/Frameworks/CoreServices.framework/Frameworks/AE.framework/Headers/AppleEvents.h`.
The header comment is the authoritative description (there is no rendered Apple docs page for it —
the obvious URL 404s). Quoting the parts that decide this ticket [D]:

> Applications can determine, **without sending an AppleEvent to a target application**, whether they
> are allowed to send AppleEvents to the target with this function. If `askUserIfNeeded` is true, and
> this application does not yet have permission to send AppleEvents to the target, then the user will
> be asked if permission can be granted; **if `askUserIfNeeded` is false and permission has not been
> granted, then `errAEEventWouldRequireUserConsent` will be returned.**
> […]
> If the user does not consent then **any future attempts to send AppleEvents will result in a
> failure with `errAEEventNotPermitted`**.
> […]
> The target `AEAddressDesc` **must refer to an already running application**.
> […]
> **Do not call this function on your main thread** because it may take arbitrarily long to return if
> the user needs to be prompted for consent.

Return values, verbatim [D]:

| Return | Constant | Meaning |
| --- | --- | --- |
| `0` | `noErr` | permitted |
| `-1743` | `errAEEventNotPermitted` | "the target of the AppleEvent does not allow this sender to execute this event" — i.e. **asked and denied** |
| `-1744` | `errAEEventWouldRequireUserConsent` | **not yet asked** (macOS 10.14+) |
| `-600` | `procNotFound` | target not running |

Also in the same header [D]: `kAEDoNotPromptForUserConsent` (`0x00020000`) can be OR'd into an
`AESend()` send mode, making a *real* Apple Event non-prompting and returning `-1744` instead. So
there are two documented ways to avoid surprising the user with a dialog. Neither is reachable
through `osascript`.

Passing `typeWildCard` for both event class and id asks "is *every* event allowed?" [D] — the right
question for a probe, since certain events are exempt from consent.

Supporting keys [D], Apple's Information Property List reference:

- `NSAppleEventsUsageDescription` — "A message that tells people why the app is requesting the
  ability to send Apple events. […] **This key is required if your app uses APIs that send Apple
  events.**"
- `LSUIElement` — "A Boolean value indicating whether the app is an agent app that runs in the
  background and doesn't appear in the Dock." Apple documents **no** restriction on such an app
  presenting or receiving system UI.

### 1.1 One secondary claim, contradicted

Felix Schwarz's 2018 write-up of the then-new API is widely cited, including the line that the
function "can't be used to silently determine the current status" and returns `-1744` regardless of
prior answers. That was written against the 10.14 beta. **It does not hold on macOS 26** [V]: §2
shows the function returning `noErr`, `-1744` and `-600` for different targets in a single silent
call. Treat the ticket's "the plugin cannot distinguish" assertion as inherited from this claim, and
now retired.

---

## 2. The silent probe is a real four-way oracle — [V]

A 40-line C binary calling the API with `askUserIfNeeded = false` against a list of bundle ids.
Run from a shell inside the live herdr session:

```
com.mitchellh.ghostty            ask=0 -> 0      noErr (permitted)
com.github.wez.wezterm           ask=0 -> 0      noErr (permitted)
com.apple.finder                 ask=0 -> -1744  errAEEventWouldRequireUserConsent
notion.id                        ask=0 -> -1744  errAEEventWouldRequireUserConsent
md.obsidian                      ask=0 -> -1744  errAEEventWouldRequireUserConsent
com.elgato.StreamDeck            ask=0 -> -1744  errAEEventWouldRequireUserConsent
com.apple.systemevents           ask=0 -> -600   procNotFound (not running)
```

Three distinct states in one call, **no dialog, no state change, no target contacted**. Cost: two
targets probed in a cold process in **30–50 ms** wall clock including process spawn [V].

`-1743` is the one value in the table not produced here, because producing it requires a human to
click *Don't Allow* (§9). It is documented [D] and is the residual `[U]`.

### 2.1 The subject is the responsible process, not the binary — [V]

Copying the probe binary to a fresh, never-executed path and running it from the same shell returned
**the same answers** (`noErr` for WezTerm, `-1744` for Obsidian). TCC is therefore not keying on the
probe binary; it resolves responsibility up the ancestry chain, which here terminates at Ghostty:

```
11026 50861 /bin/zsh
50861 50748 claude
50748 59457 -fish
59457 59456 /opt/homebrew/bin/herdr
59456  1553 herdr
 1553  1552 -/run/current-system/sw/bin/fish
 1552  1549 /usr/bin/login
 1549     1 /Applications/Ghostty.app/Contents/MacOS/ghostty
```

This is the mechanism the plugin will ride: a helper spawned by the plugin's `node`, which is spawned
by Stream Deck, resolves to `com.elgato.StreamDeck`. Measured for an ordinary spawned binary;
**[U]** for the Stream Deck chain specifically, which needs a plugin skeleton to test.

---

## 3. The prompt *is* presented to an `LSUIElement` process — [V]

The load-bearing measurement, and the one #5 could not get.

`SDProbe11.app`: ad-hoc-signed, bundle id `dev.yrh.sdprobe.research11` (never seen before),
`LSUIElement = true`, `NSAppleEventsUsageDescription` set, executable is a plain C `main` — **no
`NSApplication`, no run loop, no window, no Dock tile, no menu bar**. Launched through
LaunchServices, so `ppid == 1` and there is no terminal ancestry to inherit responsibility from.

First, the silent probe from inside that bundle:

```
pid=9505 ppid=1 ask=0
com.mitchellh.ghostty  -> -1744        com.apple.finder  -> -1744
com.github.wez.wezterm -> -1744        notion.id         -> -1744
com.elgato.StreamDeck  -> -1744
```

Everything `-1744` — a genuinely virgin TCC identity, where the shell context above had `noErr` for
two of the same targets. That alone shows the bundle *is* a distinct TCC subject and *is* ungranted.

Then the same bundle with `askUserIfNeeded = true` against Finder, polling the on-screen window list
once a second:

```
--- t=1s procs: 10387 SDProbe11
pid=72369 layer=8 owner=UserNotificationCenter
… identical at t=2s … t=8s (probe still blocked in the call)
```

**A `UserNotificationCenter` window appeared at window layer 8 and stayed** — it was absent from the
baseline capture taken minutes earlier. The call blocked for the whole time the dialog was up, then
returned `noErr` once the dialog was answered *Allow*.

So: **macOS presents the Automation consent dialog for an agent-style, windowless, AppKit-less
process with `ppid == 1`.** There is no `LSUIElement` blind spot. The system draws the dialog, not
the requesting app, which is why the app's own UI posture is irrelevant.

**[U]** The dialog's exact rendered text was not captured — reading `kCGWindowName` requires a
Screen Recording grant this session deliberately did not request, and the dialog was answered before
a screenshot path could be arranged. The wording is the one thing left for the human (§9).

---

## 4. Grants are per (client, target) pair — [V]

Immediately after the Allow above, from the same bundle:

```
com.apple.finder        ask=0 -> 0      noErr (permitted)
com.mitchellh.ghostty   ask=0 -> -1744  errAEEventWouldRequireUserConsent
```

One consent covers **one** target app. This matters for onboarding copy: a user who has been using
Stream Deck plugins that automate Spotify or Music has *not* thereby granted anything for Ghostty or
WezTerm, so a first sd-herdr press on such a machine still faces a first-run prompt. Conversely, the
grant is coarser than the user might expect in the other direction — it is Stream-Deck-wide, so once
granted, *every* installed plugin can automate the terminal (§6).

---

## 5. Why #5 saw nothing: `osascript` launders the TCC identity — [V]

This is the finding that revises window-raise-multiwindow.md §4, and it is a controlled experiment
inside a single process.

`SDProbe11b.app` (fresh bundle id `dev.yrh.sdprobe.research11b`, `LSUIElement`, `ppid == 1`) does two
things in sequence and writes both results to a file:

| Step | Target | Result |
| --- | --- | --- |
| in-process `AEDeterminePermissionToAutomateTarget(ask=false)` | `com.mitchellh.ghostty` | **`-1744`** — never asked |
| `system()` → `/bin/sh` → `/usr/bin/osascript -e 'tell application id "com.mitchellh.ghostty" to get name of front window'` | same | **exit 0, output `herdr`** |

Repeated against `md.obsidian`, a target that is `-1744` in *both* the bundle and the shell context:

| Step | Target | Result |
| --- | --- | --- |
| in-process check | `md.obsidian` | **`-1744`** |
| shelled-out `osascript` | `md.obsidian` | **exit 0, output `Obsidian`**, no prompt window |

And the same from a plain shell for control: `osascript` reached Obsidian successfully while the
in-process check under that shell's responsible process (Ghostty) said `-1744`.

`codesign -dv /usr/bin/osascript` → `Identifier=com.apple.osascript`, no team identifier, no hardened
runtime.

**Conclusion [V]**: on this machine, an Apple Event sent *through* `osascript` is not evaluated
against the calling process's TCC identity. It succeeds where the caller — by the system's own
answer, in the same process, milliseconds earlier — has no permission. Every probe in #5 (three
bundles plus a re-signed `osascript` copy) shelled out to `osascript`, so **none of them was ever
testing the bundle's grant**. The "no prompt" result was an artefact of the tool, not evidence about
`LSUIElement`.

**[U] — the mechanism.** Two explanations fit equally well and cannot be separated without reading
`TCC.db` (Full Disk Access) or a clean account:

1. **Accumulated grants.** This machine holds real `client = com.apple.osascript` rows for many
   targets from years of terminal AppleScript use, and TCC allows if *either* the direct client
   identity *or* the responsible process matches.
2. **Platform-binary handling.** `osascript` is treated as its own client rather than inheriting
   responsibility.

They differ sharply for sd-herdr: under (1) a fresh machine still prompts (named "Elgato Stream
Deck") and the design is unchanged; under (2) the plugin's AppleScript rung may never prompt at all —
or may prompt naming something the user cannot connect to Stream Deck. §9 settles it in one look.

Either way, one rule is now firm and belongs in the spec: **`osascript`'s success or failure is not a
reading of the plugin's own grant.** If the plugin ever wants to *know* its grant state, it must ask
in-process (§2), not infer it from an `osascript` exit code.

---

## 6. What the OS sees when a Stream Deck plugin sends an Apple Event

Surveyed against Elgato's SDK docs and the local installation. Full detail in the sub-report; the
load-bearing facts:

- **A plugin is a plain child process of the Stream Deck app.** [V] Live `ps` on this machine:
  `Stream Deck (982)` → `node 20.20.0 (1446)` → in Elgato's own Spotify plugin,
  `osascript (1450)`. Node plugins run Elgato's bundled Node (documented at
  [Plugin Environment](https://docs.elgato.com/streamdeck/sdk/introduction/plugin-environment/)),
  launched with `--no-global-search-paths`.
- **A `.sdPlugin` is not an app bundle.** [V] A `find` across all 20 installed plugins for
  `Info.plist` or `_CodeSignature` returned **zero** hits. No `CFBundleIdentifier`, no bundle-level
  signature. **A plugin has no code identity for TCC to key on, and no way to declare a usage
  string or an entitlement.**
- **The Stream Deck app carries the whole permission surface.** [V]
  `codesign -d --entitlements -` on `/Applications/Elgato Stream Deck.app`:
  `Identifier=com.elgato.StreamDeck`, `flags=0x10000(runtime)` (hardened),
  Developer ID *Corsair Memory, Inc. (Y93VXCB8Q5)*, **`com.apple.security.automation.apple-events =
  true`**, no App Sandbox. Its `Info.plist` has `LSUIElement = true` and

  ```
  NSAppleEventsUsageDescription = "A Stream Deck plugin wants to use AppleScripts."
  ```

  — plus the same "A Stream Deck plugin wants to…" phrasing for Camera, Microphone, Contacts,
  Calendars, Reminders, Photos and Location.

  That string is the closest thing to documentation Elgato has ever published on this subject. They
  worded every usage description around the fact that macOS shows the prompt under **the Stream Deck
  app's name and icon**, because the plugin has no name of its own to show. It also means
  §3's answer applies directly: **the Stream Deck app is itself an `LSUIElement` app**, so the whole
  "does an agent app get the prompt" worry was about a configuration Elgato has been shipping since
  Mojave.

- **Elgato documents nothing about TCC.** [V] No mention of TCC, Automation, Apple Events,
  AppleScript, entitlements, notarization or permissions across the SDK docs, the `@elgato/streamdeck`
  and `@elgato/schemas` packages, or `org:elgatosf` on GitHub. The only primary acknowledgement is a
  6.x-era support article telling users to grant **Accessibility to the Stream Deck app**.
- **Elgato ships the `osascript`-from-a-plugin pattern themselves** [V] — the first-party Spotify
  plugin runs a long-lived `osascript` watcher from three `.scpt` files. Whatever the mechanism in
  §5, this pattern demonstrably works under the current regime.
- The bundled `node` is a stock upstream build (team `HX7739G8FX`), hardened, **with no
  `apple-events` entitlement and no `Info.plist`** [V]. It therefore has no usage string of its own —
  further evidence that attribution must land on the parent, or nothing would work at all.

**[U]**: that the responsible process for a plugin's Apple Event resolves to `com.elgato.StreamDeck`
is a strongly-supported inference, not a verified fact. The two authoritative checks —
`sqlite3 TCC.db` and `launchctl procinfo <pid>` — are gated behind Full Disk Access and root. §2.1
verified the general mechanism for an ordinary spawned binary; the Stream Deck chain specifically
needs a plugin skeleton, which does not exist yet.

---

## 7. Failure shape when declined, and what changes for v1

### 7.1 Declined

[D], from the header: after a refusal, "any future attempts to send AppleEvents will result in a
failure with `errAEEventNotPermitted`" — so:

- `-1743` is what arrives, **on every attempt**, not once.
- **macOS never re-prompts.** One prompt per (client, target) pair, ever; the user must go to
  System Settings › Privacy & Security › Automation to change it.
- `AEDeterminePermissionToAutomateTarget` with `askUserIfNeeded: true` also returns `-1743` after a
  denial rather than re-prompting [D].
- Because the grant is Stream-Deck-wide (§4, §6), a user who denies for sd-herdr's terminal has
  denied it for every plugin, and sd-herdr cannot re-ask — it can only *tell them where to go*.

**[U]**: `-1743` was not observed. Producing it needs a human click on *Don't Allow*, which is §9.
Also **[U]**: what `osascript` prints on a denial, and whether it exits non-zero — #5 observed
`-1728` (no such object) formatting for a different failure, so the plugin's tier-2 error parsing
should key on the numeric code, not the message.

### 7.2 Does the answer change under AeroSpace-first? — **yes, decisively**

Under #10's ladder the AeroSpace rung runs first and needs **no TCC grant of any kind**. So:

- **This question is now tier-2-only.** It is reachable only on a machine with no supported window
  manager, where the plugin falls through to the AppleScript table.
- **It is no longer a v1 gate.** Nothing in the ladder blocks on it: rung 3 (`open -b`) needs no
  grant either, and rung 4 declines visibly. The worst outcome of an unanswered prompt is that a
  non-WM user's press degrades one rung, which the design already renders as a transient
  `showAlert()`.
- **What it *is* now** is onboarding copy, and §6 supplies it from a primary source: the first press
  on a WM-less machine may raise a system dialog reading **"Elgato Stream Deck"**, whose purpose
  string is Elgato's own *"A Stream Deck plugin wants to use AppleScripts."* The README must say
  this, because a user who has just installed *sd-herdr* will not otherwise connect the two.
- **One design option opened up.** Because §2 gives a silent oracle, a tiny bundled helper binary
  (~40 lines, spawned like any other subprocess so it inherits Stream Deck's responsibility) could
  let the plugin *know*, in ~20 ms, whether the AppleScript rung is available before trying it —
  turning "try and read the error" into "check, then choose the rung". Attractive, but it adds a
  compiled artefact to a JS plugin and a second identity story. **Recommend: not v1.** Record it as
  the escape hatch if tier-2 error handling proves unworkable.

**Verdict on the ticket**: answered. The empirical residue (§9) is small, human-only, and does not
gate anything — fold the conclusions into the spec as a caveat and carry §9 as a cheap human-run
`task` ticket, not a research one.

---

## 8. Machine state — what this research touched, and put back

- One TCC grant was created: `dev.yrh.sdprobe.research11` → Finder, by an intentional prompt.
- It was **removed** with `tccutil reset AppleEvents dev.yrh.sdprobe.research11`, scoped to that
  bundle id alone. Verified afterwards: the probe reports `-1744` for Finder again, i.e. back to
  "never asked". No grant belonging to the user, to Stream Deck, or to any real app was reset.
- **Gotcha worth recording** [V]: `tccutil reset AppleEvents <bundleid>` fails with
  `OSStatus error -10814` (`kLSApplicationNotFoundErr`) when the bundle lives under `/tmp`, even
  after `lsregister -f`. LaunchServices must be able to resolve the id to an app in a normal
  location. Copying the bundle to `~/Applications`, re-registering, then resetting works; the copy
  can be deleted afterwards. Anyone repeating this must plan the cleanup before creating the grant.
- Probe sources left at `/tmp/sdprobe11/` (`probe.c`, `probe2.c`, `wl.c`) for reproduction.

---

## 9. HITL checklist — the clean-account probe

Ten minutes, on a **freshly created macOS user account** (System Settings › Users & Groups › Add
User → Standard). A new account has an empty per-user TCC store, which is what makes this work; it is
much cheaper than a clean machine. **Do not run any of this on the main account.**

The three things only a human can produce: the dialog's *rendered wording*, a *Don't Allow* click,
and the answer to §5's mechanism question.

**Setup (2 min)**

1. Log in to the new account. Launch Stream Deck (it will start with no plugins configured) and
   Ghostty. Leave both running.
2. **Before anything else** — System Settings › Privacy & Security › **Automation**. Screenshot it.
   *Expected*: the list is empty or nearly so.
   **Check specifically whether any entry named `osascript` or `Script Editor` exists.** ← this
   single observation settles §5's `[U]`: an empty Automation pane plus a successful
   `osascript -e 'tell application id "md.obsidian" to get name'` means `osascript` is
   platform-exempt (mechanism 2); a prompt on that command means grants are ordinary (mechanism 1).

**Probe A — the wording, from a real Stream Deck plugin context (5 min)**

3. In Terminal on the new account, run:
   ```
   osascript -e 'tell application id "com.mitchellh.ghostty" to get name of front window'
   ```
   *Expected*: a prompt naming **Terminal**, not Stream Deck. **Screenshot it, then click
   Don't Allow.** Re-run the same command.
   *Record*: the exact error text and numeric code. Expected `-1743` / "Not authorized to send Apple
   events". *Record*: whether it re-prompts (expected: **no**).
   → This yields the `-1743` shape (§7.1) without needing a plugin.
4. If a plugin skeleton exists by then, install it and press its button; otherwise use the
   `/tmp/sdprobe11/SDProbe11.app` recipe from this document with a fresh bundle id.
   **Screenshot the dialog.** *Record verbatim*: the app name in the title, the target app name, and
   whether the `NSAppleEventsUsageDescription` string appears in the body.
   *Expected*, if the plugin path is used: title names **"Elgato Stream Deck"**, body contains
   *"A Stream Deck plugin wants to use AppleScripts."*

**Probe B — the `LSUIElement` re-confirmation (2 min)**

5. Copy `/tmp/sdprobe11/` to the new account, change `CFBundleIdentifier` to a fresh value,
   `codesign -f -s - SDProbe11.app`, then
   `open -a ./SDProbe11.app --args -o /tmp/out.txt --ask com.mitchellh.ghostty`.
   *Expected*: dialog appears within ~1 s naming **SDProbe11**. **Screenshot.** Click
   **Don't Allow**.
6. Re-run without `--ask`:
   `open -a ./SDProbe11.app --args -o /tmp/out2.txt com.mitchellh.ghostty`.
   *Expected*: `-1743`. **This is the one value in §2's table still unmeasured.** Run it twice more
   and confirm `-1743` every time and no re-prompt.

**Teardown (1 min)**

7. Screenshot the Automation pane again (it should now show the denials).
8. Log out and delete the account. Nothing needs resetting — the store dies with the account.

**What to bring back**: three screenshots (dialog wording ×2, Automation pane), the literal `-1743`
output, and a one-line answer to step 2's `osascript` question.

---

## 10. Still unverified

- **[U]** `-1743` never observed here; documented only. §9 step 6.
- **[U]** The dialog's exact rendered wording, and whether the usage-description string is shown in
  the Automation prompt body at all. §9 step 4.
- **[U]** Which of §5's two mechanisms explains `osascript`'s bypass. §9 step 2.
- **[U]** That a Stream Deck plugin's Apple Event is attributed to `com.elgato.StreamDeck`. Verified
  for ordinary spawned binaries (§2.1); the Stream Deck chain needs a plugin skeleton, and joins the
  map's existing "verify the plugin's runtime environment" item.
- **[U]** Whether Elgato's bundled Node can load a native addon on 7.x (the `--no-addons` flag is
  documented as 6.4-only), which is what §7.2's helper-binary option would depend on if implemented
  in-process rather than as a spawned executable.
