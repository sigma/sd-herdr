# Does the window-nonce raise hold up outside the single-window happy path?

Research for [#5](https://github.com/sigma/sd-herdr/issues/5) (map: [#1](https://github.com/sigma/sd-herdr/issues/1)),
following on from [#3](https://github.com/sigma/sd-herdr/issues/3) /
[`terminal-window-discovery.md`](./terminal-window-discovery.md).

Every claim below is tagged **VERIFIED** (command run on this machine, output observed) or
**INFERRED** (reasoned from schema, `sdef`, entitlements, or documented platform behaviour, not
executed).

Test bed, all VERIFIED:

| | |
|---|---|
| OS | macOS 26.5.2, Darwin 25.5.0, arm64 |
| herdr | 0.8.0, protocol 19, `/opt/homebrew/bin/herdr` |
| Session under test | throwaway `scratch5` (`~/.config/herdr/sessions/scratch5/`), created and deleted for this work |
| Host terminals | Ghostty `com.mitchellh.ghostty` (pid 1549, 12 d uptime); WezTerm `com.github.wez.wezterm` (Nix-store bundle, pid 65821) |
| Tiling WM | AeroSpace `0.21.3-Beta`, config `~/.aerospace.toml` |

The live `default` session was never focused, retitled, or otherwise mutated. All probes ran against
`scratch5`, which was stopped and deleted afterwards.

---

## TL;DR — verdict

**Per-window targeting is viable, but only on host apps that expose a window vocabulary to
AppleScript.** That is not a property of the nonce; it is a property of the terminal.

- On **Ghostty**, the nonce raise is **VERIFIED correct 10/10** with 3–6 windows open, including a
  decoy window carrying a *stale* nonce from an earlier press. §1.
- On **WezTerm**, the nonce **lands in the window title** (VERIFIED, observable through AeroSpace)
  but WezTerm answers `-1728` to every window query, so the title is unusable and the raise degrades
  to app-level. §1.4. WezTerm is running on this machine with 5 windows — this is not a hypothetical.
- The **title race does not exist**. VERIFIED: herdr does *not* re-assert its own window title while
  a custom one is set — not on pane focus, pane split, cwd change, agent status change, tab create,
  workspace create, workspace focus, or 20 s idle. §2.
- A **new failure mode did surface**: if the client dies while a nonce is set, the nonce is
  **stranded** in the dead window's title bar and `client.window_title.clear` can never remove it
  (`no_foreground_client`). VERIFIED. §2.3. The nonce must therefore be human-tolerable, not opaque.
- **`herdr session attach` from a different terminal works**, and discovery correctly reports the
  *new* host app rather than the one that started the session. VERIFIED end to end, Ghostty →
  WezTerm. §3.2.
- Under **AeroSpace**, `activate window` on a window parked on a *non-focused* workspace switches the
  workspace and makes the window visible. VERIFIED. "Raised" does mean "visible". §5.
- Conversely, the `open -b` fallback under AeroSpace is **worse than the ticket assumed**: VERIFIED
  that it raised whichever Ghostty window the WM had on the *currently focused* workspace, i.e. the
  wrong one, deterministically. §5.2.
- **New option**: where the `aerospace` CLI is present it is a **generic, app-agnostic per-window
  raise** — `aerospace list-windows` gives title → window-id for *every* app including WezTerm, and
  `aerospace focus --window-id` raises it, with no TCC grant needed by the plugin. VERIFIED. §5.3.
- The **first-run Automation prompt could not be reproduced** on this machine by any means tried,
  including a freshly-created `LSUIElement` bundle with a never-seen bundle id launched with
  `ppid == 1`. §4. This bullet is **unresolved by execution** and stays INFERRED.

---

## 1. Multi-window targeting — the load-bearing unknown

### 1.1 It works on Ghostty

Test bed: three Ghostty windows created with distinct OSC-2 titles (`GW-1`, `GW-2`, `GW-3`) plus the
user's live `herdr` window. Each trial activates a rotating target, then reads back the front window
after a 1.2 s settle, cross-checked against `aerospace list-windows --focused`.

```
tell application id "com.mitchellh.ghostty" to activate window (first window whose name is "GW-2")
```

VERIFIED, 10 trials, both oracles agreeing every time:

```
trial1 target=GW-2 front=GW-2 aerospace=GW-2
...
trial10 target=GW-2 front=GW-2 aerospace=GW-2
OK=10 FAIL=0
```

VERIFIED separately with the *real* mechanism rather than synthetic titles: with 3 Ghostty windows
(`DECOY-WINDOW`, live `herdr`, and the `scratch5` client's window), a `client.window_title.set` nonce
landed on the scratch5 window and `activate window (first window whose name is NONCE)` brought
exactly that window to the front — the nonce window was *third* in Ghostty's front-to-back ordering
at the time, so this is not an artefact of it already being frontmost.

VERIFIED again at 4 windows, where one of the four was a **stale-nonce decoy** (a window still
carrying `SD-HERDR-N5-ccc3` from a previous, now-dead client). The live nonce `…-ddd4` was still
targeted correctly.

VERIFIED: `osascript` wall time for a single `activate window` call is **0.11 s**.

### 1.2 Reading back the result races; the raise itself does not

One early run appeared to raise the wrong window. VERIFIED, it was a *measurement* race: two
`activate window` calls issued back-to-back inside a single `osascript` with a `delay 1` between them
reported `front window` as a third, uninvolved window. Re-measured after a 2 s settle, and in 10
independent trials with one activation per process, the result was always correct.

Design consequence: **do not verify a raise by reading back `front window` immediately.** It is not a
reliable success oracle within ~1 s of the call, and the plugin has nothing useful to do with the
answer anyway.

### 1.3 No-match and duplicate-match behaviour

VERIFIED:

| Probe | Result |
|---|---|
| `activate window (first window whose name is "NO-SUCH…")` | `execution error … Invalid index. (-1719)` |
| `get id of (first window whose name is "NO-SUCH…")` | same, `-1719` |
| `count (every window whose name is "NO-SUCH…")` | `0` — **no exception** |
| `count (every window whose name is "DUPTITLE")` with two such windows | `2` |
| `activate window (first window whose name is "DUPTITLE")` with two such windows | raises the front-most of the two |

So `count (every window whose name is NONCE)` is a **cheap, exception-free pre-check**: `0` means
fall back to app-level, `1` means raise with confidence, `>1` means the nonce collided (which a
per-press random nonce should make impossible) and the raise is a guess.

### 1.4 It does not work on WezTerm, and WezTerm is on this machine

VERIFIED, `herdr session attach scratch5` hosted in a WezTerm window, nonce set successfully:

```
$ python3 hreq.py …/scratch5/herdr.sock client.window_title.set '{"title":"SD-HERDR-N5-eee5"}'
{"id":"sd","result":{"type":"client_window_title","changed":true,"reason":"set"}}

$ aerospace list-windows --monitor all --app-bundle-id com.github.wez.wezterm
28653 T SD-HERDR-N5-eee5      <- the nonce did reach the real window title
28643 T wezterm
28646 T wezterm
28649 T zsh
24340 T ~/s/g/s/callctl

$ osascript -e 'tell application id "com.github.wez.wezterm" to get name of every window'
execution error: WezTerm got an error: Can't get name of every window. (-1728)
$ osascript -e 'tell application id "com.github.wez.wezterm" to get properties'
execution error: WezTerm got an error: Can't get every property. (-1728)
```

WezTerm responds to Apple Events (it is a scriptable target — the error is `-1728` "can't get", not
`-1743` "not permitted") but exposes **no `window` element and no properties**. With five WezTerm
windows open, an `open -b com.github.wez.wezterm` fallback has a 1-in-5 chance of being right.

This is the concrete instance of the adapter table's default branch, and it is the *second* terminal
on the machine that motivated the design. The nonce is still worth setting on unknown hosts — it
costs one socket round trip, and it is what makes the AeroSpace adapter in §5.3 possible.

---

## 2. Title stability — herdr does not fight for the title

### 2.1 herdr does own the title, but only asserts it on clear

VERIFIED sequence on `scratch5`:

- A Ghostty window launched with an explicit `command` (no shell) and a herdr client in it keeps
  Ghostty's default title `👻`. herdr sets **nothing** at startup.
- `client.window_title.set` → title becomes the nonce.
- `client.window_title.clear` → title becomes **`herdr`**, not `👻`. So herdr *does* write a title,
  but only as part of the clear/restore path.
- A Ghostty window launched with `/bin/zsh -i` shows `~` (zsh's own title), and running
  `herdr session attach scratch5` in it changed the title to the command line — the **shell**, not
  herdr, was the entity rewriting the title.

This revises §2.3 of the prior research: the `herdr ~` title observed there was almost certainly the
*shell's* precmd title (command name + cwd), not herdr's. Under herdr the client is a long-lived
foreground process, so the shell emits no further titles until it exits.

### 2.2 Nothing herdr does re-asserts over a set nonce

VERIFIED. With `SD-HERDR-N5-aaa1` set, the window title was re-read after each of the following, and
was unchanged every time:

| Event provoked | Method | Title after |
|---|---|---|
| Pane split | `pane.split {direction:"right", focus:true}` | nonce |
| Pane focus (p1) | `pane.focus {pane_id:"w1:p1"}` | nonce |
| Pane focus (p2) | `pane.focus {pane_id:"w1:p2"}` | nonce |
| cwd change (`cd /tmp`) | `pane.send_text` — snapshot confirms `cwd` went `/Users/yann` → `/private/tmp` and `terminal_title` → `/tmp` | nonce |
| Agent status → `working` | `pane.report_agent` | nonce |
| Agent status → `blocked` | `pane.report_agent` | nonce |
| Tab create | `tab.create` | nonce |
| Workspace create | `workspace.create` | nonce |
| Workspace focus | `workspace.focus` | nonce |
| 20 s idle | — | nonce |

Note also VERIFIED: pane-level titles are **swallowed** by herdr, not forwarded. Pane `w1:p1` had
`terminal_title: "~"` in the snapshot while the *window* title was the nonce. A program inside a pane
emitting OSC 0/2 therefore cannot clobber the nonce — herdr captures it into the snapshot instead.

**The set→raise→clear race described in the ticket does not exist.** The nonce's lifetime is bounded
only by the plugin's own `.clear` and by client death.

### 2.3 New failure mode: the stranded nonce

VERIFIED. With the nonce set, the client process was killed (`kill -TERM`), simulating a closed
terminal window or a crash:

```
$ python3 hreq.py …/scratch5/herdr.sock client.window_title.clear '{}'
{"id":"sd","result":{"type":"client_window_title","changed":false,"reason":"no_foreground_client"}}

$ osascript -e '… get name of every window'
tab-group-b92b6af80 :: herdr
tab-group-b922d19a0 :: SD-HERDR-N5-ccc3      <- stranded, permanently
tab-group-b92d25860 :: DECOY-WINDOW
```

The dead client's window keeps the nonce in its title bar forever, and there is no API that can
remove it — `clear` requires a foreground client. Recovery is closing the window.

Consequences for the spec:

- The nonce string must be **legible to a human who sees it stuck in a title bar**. Something like
  `herdr · default` plus a short suffix, not a raw hex blob.
- A stranded nonce is also a **stale decoy** for future presses (§1.1 exercised exactly this case).
  Per-press unique nonces make a false match impossible; a *constant* marker string would not.

---

## 3. Client topologies

### 3.1 Detached — everything reports honestly

VERIFIED after killing the `scratch5` client:

| Probe | Result |
|---|---|
| `client.window_title.set` | `{"changed":false,"reason":"no_foreground_client"}` |
| `client.window_title.clear` | `{"changed":false,"reason":"no_foreground_client"}` |
| `lsof` peer-device correlation | `serverPids [69400] clientPids []` |
| `ps` | server survives, **reparented to `ppid 1`** |
| `herdr session list` | session still `running` |

All three of the prior research's INFERRED claims about the detached case are now VERIFIED: the
correlation returns no clients, the server reparents to launchd, and `no_foreground_client` is a
free, authoritative "nothing to raise" signal that costs one socket round trip and needs no `lsof`.

### 3.2 `herdr session attach` — including a different host app

VERIFIED, attach from a *Ghostty* shell window:

```
serverPids [69400] clientPids [72174]
client 72174 -> top 1549 -> ghostty|com.mitchellh.ghostty
  chain: 72174:herdr < 71927:zsh < 71925:login < 1549:ghostty
```

VERIFIED, the realistic case — session started under Ghostty, then re-attached from **WezTerm**:

```
serverPids [69400] clientPids [73373]
client 73373 -> top 65821 -> wezterm-gui|com.github.wez.wezterm
  chain: 73373:herdr < 73371:zsh < 65821:wezterm-gui
```

Discovery reports the **current** host app, not the one that created the session. The Nix-store
WezTerm bundle (`…/WezTerm.app/wezterm-gui`, no `Contents/MacOS/`) resolves correctly, re-confirming
that `ppid == 1` + System Events beats any path regex.

**One client at a time.** VERIFIED: attempting `herdr session attach` while another client is
attached makes the new client exit immediately. `clientPids.length > 1` (listed as an ambiguity case
in the prior research) was never observed and may not be reachable for a single session.

**Gotcha worth recording**, VERIFIED: `herdr session attach` refuses to run if `HERDR_ENV` and
friends are in the environment — `error: nested herdr is disabled by default`. Any tooling that
spawns a herdr client from inside a herdr pane must strip `HERDR_ENV`, `HERDR_SOCKET_PATH`,
`HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`. (Irrelevant to the plugin, which never spawns
clients; relevant to any future test harness.)

---

## 4. First-run Automation prompt from an `LSUIElement` app — NOT ESTABLISHED

This is the one ticket bullet that could **not** be resolved by execution, and the reason is worth
recording precisely.

The plan was to reproduce a virgin-client Apple Event and watch for the TCC dialog. Reproducing it
against `com.elgato.StreamDeck` itself would have required `tccutil reset AppleEvents
com.elgato.StreamDeck`, which would revoke the user's existing, working grants for their other
Stream Deck plugins. Not done — out of bounds for a research ticket.

Instead, three throwaway app bundles were built with never-before-seen bundle ids
(`dev.yrh.sdprobe.research5{,b,c}`), each ad-hoc code-signed, each carrying `LSUIElement = true` and
`NSAppleEventsUsageDescription`, mirroring the Stream Deck app's posture. VERIFIED results:

| Probe | Launched via | `ppid` of app | Target | Outcome |
|---|---|---|---|---|
| SDProbe | `open` from a shell | — | Ghostty `get name of every window`; System Events `application process whose unix id is` | **both succeeded, no prompt** |
| SDProbe2 | `open` from a shell | — | Notion (`notion.id`) `get name` | **succeeded, no prompt** |
| SDProbe3 | `tell application "Finder" to open …` | **1** (launchd — no terminal ancestry to inherit from) | Notion `get name` | **succeeded, no prompt** |
| ad-hoc re-signed copy of `/usr/bin/osascript` at `/tmp/osa2` | shell | — | Notion `get name` | **succeeded, no prompt** |

No TCC dialog ever appeared (polled every 2 s for up to 16 s against the visible-process list), and
no call was denied.

The most likely explanation, INFERRED: the ad-hoc re-signed copy retains
`Identifier=com.apple.osascript` (VERIFIED via `codesign -dv`), and this machine already holds
Automation grants keyed on that identifier, so *any* process that shells out to `osascript` inherits
them. That would make it impossible to observe a first-run prompt here through `osascript` at all,
regardless of the calling bundle. SDProbe3 rules out the other candidate explanation (TCC
responsibility inheritance from the launching terminal), since it was launched by Finder with
`ppid == 1`.

Also VERIFIED, and relevant: **the plugin cannot introspect its own grants.** Reading
`~/Library/Application Support/com.apple.TCC/TCC.db` fails with `unable to open database file`
without Full Disk Access. There is no supported way to ask "do I have Automation permission for
bundle X?" short of trying it and reading the error.

What this leaves, unchanged from #3 and still INFERRED:

- A denied Automation grant surfaces as **`-1743 errAEEventNotPermitted`**, which the plugin can
  detect and render as a distinguishable "needs permission" face.
- Whether the prompt is *visible* when the requesting app is `LSUIElement` (no Dock icon, no menu
  bar) is **unknown**. The dialog is presented by the system, not the app, so it should appear; but
  it will be attributed to "Elgato Stream Deck" and will name the *target* terminal, so a user who
  has never heard of sd-herdr sees "Elgato Stream Deck wants to control Ghostty".
- **`open -b <bundleid>` needs no TCC grant of any kind.** That remains the one step in the design
  that cannot be permission-walled, and it is why the degraded contract in §6 is always reachable.

Recommendation: treat the first-run prompt as a documented onboarding step (README: "the first press
will ask to control your terminal; say Allow"), and make the `-1743` face self-explanatory. Do not
gate the design on observing it. A clean-machine check remains open.

---

## 5. Tiling window managers (AeroSpace)

### 5.1 `activate window` beats the tiler — raised *does* mean visible

VERIFIED. The `~/.aerospace.toml` on this machine auto-assigns every Ghostty window to workspace `E`:

```toml
[[on-window-detected]]
if.app-id = 'com.mitchellh.ghostty'
run = ['layout tiling', 'move-node-to-workspace E']
```

The nonce window was manually moved to workspace `P`, focus returned to `E` (confirmed: focused
window was the live `herdr` window on `E`), then:

```
$ osascript -e 'tell application id "com.mitchellh.ghostty" to activate window (first window whose name is "SD-HERDR-N5-ddd4")'
   (0.11 s)
$ aerospace list-workspaces --focused          -> P
$ aerospace list-windows --focused             -> 28622 P Ghostty SD-HERDR-N5-ddd4
$ osascript -e '… get name of front window'    -> SD-HERDR-N5-ddd4
```

AeroSpace **followed** the activation: it switched the focused workspace to `P` and made the window
visible and focused. Repeated across two independent runs. The prior research's worry ("raised may
not mean visible") does not hold for AeroSpace.

### 5.2 …but `open -b` under a tiler is actively wrong, not merely imprecise

VERIFIED, the same setup with the nonce window on `P` and focus on `E`:

```
$ open -b com.mitchellh.ghostty
$ aerospace list-workspaces --focused   -> E          (unchanged)
$ aerospace list-windows --focused      -> 206 E Ghostty herdr
$ osascript -e '… get name of front window' -> herdr
```

The app-level fallback raised the Ghostty window the WM happened to have on the *currently focused*
workspace — the wrong one, and deterministically so, not by chance. Under a tiling WM the
"app-level raise is good enough with one window" consolation is weaker than assumed: it will
reliably re-raise whatever the user is already looking at, which reads to the user as "the button
did nothing".

### 5.3 New: AeroSpace as a generic per-window raise adapter

This was not in the ticket, and it is the most useful thing found. VERIFIED:

```
$ aerospace list-windows --monitor all --format '%{window-id} %{workspace} %{app-name} %{window-title}'
28653 T WezTerm SD-HERDR-N5-eee5
206   E Ghostty herdr
…
$ aerospace focus --window-id 28653 ; echo $?
0
$ aerospace list-workspaces --focused        -> T
$ aerospace list-windows --focused           -> 28653 T WezTerm SD-HERDR-N5-eee5
```

Properties, all VERIFIED:

- It is **app-agnostic** — it raised a **WezTerm** window by title, which AppleScript cannot do at
  all (§1.4).
- It needs **no TCC grant from the plugin**. AeroSpace holds the Accessibility grant; the plugin only
  spawns a CLI binary. This sidesteps the entire §4 wall of #3.
- `aerospace focus --window-id` on a **non-existent** window id exits `2` with
  `Invalid <window-id> N passed to --window-id` — a clean, non-throwing discriminator (this is how a
  stale cached id is detected; observed after the user closed the test windows mid-run).
- Latency is ~0.02 s.

Suggested placement in the adapter table: **probe for the `aerospace` binary first**; if present, use
title → window-id → `aerospace focus`. Fall back to the per-bundle-id AppleScript adapter, then to
`open -b`. It only helps AeroSpace users, but for them it upgrades every unknown terminal from
"app-level raise" to "exact window", and it is the only path that gets WezTerm right.

Not tested, INFERRED: yabai exposes an equivalent (`yabai -m query --windows` /
`yabai -m window --focus`), so the same shape generalises. Not tested: whether AeroSpace's
`on-window-detected` rules can *fight* an activation by yanking the window back to its assigned
workspace — the rules fire on window *detection*, not on focus, so this should not happen. Not
observed in any run.

---

## 6. What the press contract should say

Per-window targeting is viable, so the strong contract survives — but it must be stated
**conditionally on the host app**, and the degraded branch must be honest.

Recommended wording, three tiers:

1. **Exact** — *"raises the terminal window running this herdr session and focuses the waiting
   agent."* Available when the nonce matched exactly one window through an adapter that can raise it:
   an AppleScript adapter for the bundle id (Ghostty, Terminal.app, iTerm2), or the AeroSpace CLI.
2. **App-level** — *"brings the terminal app forward; if it has several windows, it may not be the
   right one."* Reached when the host app is known but has no window vocabulary and no WM adapter
   (WezTerm, Alacritty, kitty), or the nonce matched nothing. §5.2 makes this genuinely weak under a
   tiling WM; the plugin must render a **visible hint** that it degraded, not fail silently.
3. **Nothing to raise** — *"no terminal is attached to this session."* Reached on
   `reason == "no_foreground_client"` (§3.1), which is authoritative and free. This is a *distinct*
   tile state, not a failure.

Additional contract-shaping facts:

- The tier is knowable **before** the press completes (host bundle id + presence of an adapter +
  `count every window whose name is NONCE`), so the tile could in principle advertise which tier it
  is in. Worth considering; not required for v1.
- Do **not** promise "the window is now on screen" beyond tier 1. Tier 2 under a tiler is where that
  promise breaks.
- Always `.clear` the nonce, but accept that a client that dies mid-press strands it (§2.3), so pick
  a nonce a human can live with seeing.

---

## 7. Answers to #3's open questions

| #3 question | Status |
|---|---|
| 1. Multi-window targeting unproven | **Resolved.** VERIFIED 10/10 on Ghostty at 3–6 windows, incl. a stale-nonce decoy. Fails on non-scriptable terminals (WezTerm) — a host-app property, not a nonce property. §1 |
| 2. Does herdr overwrite the nonce on its own events? | **Resolved: no.** VERIFIED across 9 event classes + idle. herdr only writes the title on `clear`. §2 |
| 3. Detached and `session attach` not exercised | **Resolved.** Both VERIFIED, including a cross-app attach Ghostty → WezTerm. §3 |
| 4. First-run Automation prompt from an `LSUIElement` app | **Not established.** Could not be provoked by any of four probes; most likely masked by an existing `com.apple.osascript`-keyed grant on this machine. §4 |
| 5. Does raising work under AeroSpace? | **Resolved: yes**, and AeroSpace additionally offers a *better* generic adapter than AppleScript. §5 |

---

## 8. New questions surfaced

1. **Should the AeroSpace/WM adapter be part of v1?** It is the only path that gets a non-scriptable
   terminal right, and it needs no TCC grant — but it is a third mechanism to maintain and only
   helps tiling-WM users.
2. **Does the tile need to advertise which press tier it is in?** §6 notes the tier is knowable ahead
   of the press; #4's face design has no slot for it.
3. **`pane.report_agent` cannot report `done`.** VERIFIED: the write-side enum is
   `idle | working | blocked | unknown` — `done` is rejected with `unknown variant \`done\``, even
   though the read-side `AgentStatus` includes it. So `done` is a state herdr *derives*, not one an
   integration asserts. This bears directly on [#6](https://github.com/sigma/sd-herdr/issues/6)'s
   premise that focusing a `done` agent flips it to `idle`, and it constrains how #6 can be tested —
   a `done` agent cannot be synthesised over the socket.
4. **Multiple simultaneous clients on one session may be unreachable.** §3.2: a second
   `herdr session attach` exits immediately. If so, the `clientPids.length > 1` branch in #3's
   failure table is dead code.

## Appendix: reproduction

Socket request helper (`/tmp/hreq.py`) — one request per connection, per #2:

```python
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.connect(sock)
s.sendall((json.dumps({"id": "sd", "method": method, "params": params}) + "\n").encode())
# read one line, then the server hangs up
```

Creating a Ghostty window running a specific command (how every test window here was made):

```applescript
tell application id "com.mitchellh.ghostty" to new window with configuration ¬
  {command:"/opt/homebrew/bin/herdr --session scratch5", wait after command:true}
```

Driving an existing window (used to run `herdr session attach` in a shell window):

```applescript
tell application id "com.mitchellh.ghostty"
  set tm to focused terminal of (selected tab of window id "…")
  input text "…" to tm
  delay 0.5
  send key "enter" to tm
end tell
```

Ambiguity-safe raise:

```applescript
tell application id "com.mitchellh.ghostty"
  if (count (every window whose name is NONCE)) is 1 then
    activate window (first window whose name is NONCE)
  end if
end tell
```
