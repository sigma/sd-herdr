# Finding and raising the terminal window that hosts a herdr client

Research for [#3](https://github.com/sigma/sd-herdr/issues/3) (map: [#1](https://github.com/sigma/sd-herdr/issues/1)).

Every claim below is tagged **VERIFIED** (command run on this machine, output observed) or
**INFERRED** (reasoned from schema, `sdef`, entitlements, or documented platform behaviour, not
executed).

Test bed, all VERIFIED:

| | |
|---|---|
| OS | macOS 26.5.2, build 25F84, Darwin 25.5.0, arm64 |
| herdr | 0.8.0, protocol 19, `/opt/homebrew/bin/herdr` |
| Host terminal | Ghostty `com.mitchellh.ghostty`, `/Applications/Ghostty.app` |
| Also running | WezTerm `com.github.wez.wezterm` (Nix-store bundle), AeroSpace tiling WM |
| Stream Deck | `com.elgato.StreamDeck` 7.4.2.22730, `/Applications/Elgato Stream Deck.app` |

---

## TL;DR — recommendation

Three independent facts do the work, and each has to come from a different place:

1. **Which application** hosts the client → **process-tree walk** (`lsof -U` peer correlation +
   `ps` ppid walk + `System Events` pid→bundle-id lookup). No Accessibility permission needed.
2. **Which window** inside that application → **`client.window_title.set` nonce**, then match the
   window by title. No Accessibility permission needed.
3. **Raising it** → **per-app AppleScript adapter** keyed on the bundle id discovered in (1), with
   `open -b <bundleid>` as a universal app-level fallback.

The mechanism is a **hybrid**: neither angle alone is sufficient. The process walk cannot name a
window; the title nonce cannot name an application (you must already know whom to ask).

**Deliberately not recommended: `System Events` UI scripting (`AXRaise`, `window` elements).** It is
the only truly app-agnostic path, and it is exactly the silent-failure wall the ticket warns about —
see [Permissions](#4-permissions-tcc) for the verified evidence.

---

## 1. Process-tree walk

### 1.1 The socket topology is the opposite of what the ticket assumed

The ticket says "the client socket at `~/.config/herdr/herdr-client.sock` has a peer process; walk
its ancestors". That is backwards. VERIFIED:

```
$ lsof ~/.config/herdr/herdr-client.sock
COMMAND   PID USER   FD   TYPE  DEVICE            NAME
herdr   59457 yann    9u  unix  0xbf79beb3c6e48fd  .../herdr-client.sock
herdr   59457 yann   10u  unix  0x8cecf13827963c8f .../herdr-client.sock
herdr   59457 yann   11u  unix  0x8cecf13827963c8f .../herdr-client.sock
```

`herdr-client.sock` is a socket the **server listens on**; the TUI client **connects to it**.
VERIFIED process shapes:

```
59456  ppid 1553  tty ttys000  stat S+   herdr           <- TUI client, foreground, on a pty
59457  ppid 59456 tty ??       stat Ss   herdr server    <- daemon, stdio on /dev/null, session leader
```

Consequence: **if the plugin connects to either socket and asks for its peer pid, it gets the
*server* (59457), not the client.** The server is a daemon; it survives client death and reparents to
`launchd`, so its ancestry says nothing about any terminal. Peer-pid-of-our-own-connection is a dead
end regardless of how it is obtained.

(Aside, INFERRED: Node has no `getsockopt(LOCAL_PEERPID)` binding on `net.Socket` anyway; it would
need a native addon or FFI. Moot, given the above.)

### 1.2 What works: correlate the server's *accepted* connections

`lsof -U -F pcdn` prints every unix socket with pid / command / device / name. Connected sockets
render their peer as `->0x<device>`. VERIFIED extract:

```
p59456
cherdr
f5
d0xa8f37b4fd9f74edf
n->0x8cecf13827963c8f     <- client's connected end, pointing at ...
p59457
cherdr
f10
d0x8cecf13827963c8f       <- ... the server's accepted end, named with the socket path
n/Users/yann/.config/herdr/herdr-client.sock
```

Algorithm:

1. Parse `lsof -U -F pcdn`.
2. Collect devices `D` and pids `S` of every row whose `n` equals the client socket path.
3. Client pids = pids of rows whose `n` is `->d` for `d ∈ D`, excluding `S`.

VERIFIED: `-U` restricts lsof to unix sockets and runs in **0.07 s**; the whole Node discovery
including the `osascript` hop runs in **0.26 s**. VERIFIED it needs no elevated privilege (same-uid
processes only). VERIFIED lsof's `WARNING: can't stat() smbfs file system` noise goes to stderr and
does not corrupt `-F` parsing.

### 1.3 The ancestor walk: do not regex the path for `.app/Contents/MacOS/`

The naive termination test — match the command path against `.app/Contents/MacOS/` — is wrong.
VERIFIED counterexample on this machine:

```
65821  ppid 1  /nix/store/2kmqgwd69q2wnbi5zghg05fxqbg0409b-wezterm-0-unstable-2025-10-14/Applications/WezTerm.app/wezterm-gui
```

A Nix-packaged WezTerm has its executable directly inside `WezTerm.app/`, not under
`Contents/MacOS/`. Path-shape heuristics will miss it. Given that this repo's own toolchain is Nix,
this is not a hypothetical.

**Use the ppid chain to find the top-level ancestor (`ppid == 1`), then ask `System Events` whether
that pid is a GUI application process.** VERIFIED, all three cases:

```
$ osascript -e 'tell application "System Events" to tell (first application process whose unix id is 1549) to return {name, bundle identifier}'
ghostty, com.mitchellh.ghostty

$ ... unix id is 65821 ...
wezterm-gui, com.github.wez.wezterm

$ ... unix id is 59457 ...   # the herdr server daemon, not a GUI app
execution error: System Events got an error: Can't get application process 1 whose unix id = 59457. Invalid index. (-1719)
```

Error `-1719` is a clean "not a GUI app" discriminator. Crucially, VERIFIED: **querying
`application process` by `unix id` does *not* require Accessibility permission** — it is process
metadata, not UI-element access. Contrast with §4.

Note also VERIFIED: the `System Events` *process* name is `ghostty` (lowercase, the executable name)
while the AppleScript *application* name is `Ghostty`. Address apps by **bundle identifier**
(`tell application id "com.mitchellh.ghostty"`), never by name. VERIFIED that form works.

### 1.4 End-to-end result

VERIFIED, from Node 24 via `execFileSync`, 0.26 s wall:

```
{ "serverPids": [59457], "clientPids": [59456] }
client 59456 -> top 1549 -> app {"name":"ghostty","bundleId":"com.mitchellh.ghostty"}
  chain: 59456:herdr < 1553:fish < 1552:login < 1549:ghostty
```

The chain terminates on the GUI app, not on the shell or on `login`. VERIFIED it has held for
5 days of uptime (client started Aug 12, Ghostty started Aug 5) — the daemon did **not** reparent
away, and the client never detached from its process group.

### 1.5 Failure modes of the walk

| Case | Behaviour | Confidence |
|---|---|---|
| Detached session (no client attached) | Step 2 finds the listening socket but no `->` peers; `clientPids` is empty. Correctly reports "no host window". | INFERRED (could not detach the live session) |
| `herdr session attach <name>` | Produces an ordinary tty-attached client process in whatever terminal ran the command; identical shape to §1.2. Each named session has its own socket pair, so the correlation is per-session. | INFERRED |
| Client inside tmux / zellij / screen | The ppid chain terminates at the **multiplexer server**, which is daemonized under `launchd`. `System Events` returns `-1719`. Walk yields nothing. | INFERRED (strong — daemonized muxers are the norm) |
| Client over SSH | Chain terminates at `sshd`. Same `-1719`. Out of scope per #1 anyway. | INFERRED |
| Multiple clients on one session | `clientPids` returns several. Ambiguous. Prefer the one herdr considers *foreground* — see §2.3. | INFERRED |
| Nix-store / non-standard bundle layout | Handled, because termination is `ppid == 1` + `System Events`, not path regex. | VERIFIED (WezTerm) |
| Terminal that does not re-parent shells to itself | Chain would terminate elsewhere. Not observed. Ghostty inserts `login`, and the chain still lands on Ghostty. | VERIFIED for Ghostty |

---

## 2. Window-title hunt

### 2.1 The API

VERIFIED from `herdr api schema --output`:

- `client.window_title.set` → `{ "title": string }` (required, non-empty)
- `client.window_title.clear` → `{}`
- Result: `{ "type": "client_window_title", "changed": bool, "reason": "set" | "cleared" | "no_foreground_client" }`

`no_foreground_client` is a free liveness signal: it is herdr telling you there is no attached
terminal to raise. Use it to short-circuit before doing any window hunting.

Requests go over the **session socket** (`~/.config/herdr/herdr.sock` for `default`),
newline-delimited JSON, with a caller-chosen string `id`.

### 2.2 It works, and it is observable

VERIFIED round trip on the live session:

```
before: window name = "herdr ~"
send  : {"id":"sd-1","method":"client.window_title.set","params":{"title":"SD-HERDR-PROBE-7f3a"}}
recv  : {"id":"sd-1","result":{"type":"client_window_title","changed":true,"reason":"set"}}
after : osascript -e 'tell application "Ghostty" to get name of every window'  ->  SD-HERDR-PROBE-7f3a
```

VERIFIED it **persisted across 24 s of idle** (sampled at 8 s intervals, unchanged). VERIFIED it is
reversible: `client.window_title.clear` returned `reason: "cleared"` and the title reverted to
`herdr`.

VERIFIED gotcha: `title: ""` is rejected with `{"code":"invalid_params","message":"window title is
empty"}`. You must use the separate `.clear` method to restore.

VERIFIED window lookup by title works as an AppleScript specifier filter:

```
$ osascript -e 'tell application "Ghostty" to get id of (first window whose name is "herdr")'
tab-group-b92b6af80
```

### 2.3 Limits

- **It names a window, not an application.** You cannot iterate "every window of every app" without
  `System Events` UI scripting, which is permission-walled (§4). So the title nonce is only useful
  *after* §1 has told you which app to ask. Confirms the hybrid.
- **Overwrite risk.** herdr owns the title while its client is foreground (it set `herdr ~`
  unprompted, and `~` tracks cwd), so herdr itself is the entity most likely to overwrite the nonce
  — e.g. on pane focus or cwd change. INFERRED (not provoked, to avoid disturbing the live session).
  Mitigation: keep the set→match→raise→clear window as short as possible (sub-second), and treat a
  no-match as "fall back to app-level activation", never as an error.
- **`no_foreground_client`** means the set silently did nothing. Always branch on `reason`, not just
  on the absence of an error.
- A shell or program that emits its own OSC 0/2 could clobber the title, but under herdr the client
  owns the tty, so INFERRED this is not a practical concern.

---

## 3. Raising a specific window

### 3.1 What is available, ranked

| Mechanism | Targets | TCC needed | Verdict |
|---|---|---|---|
| `open -b <bundleid>` / `open -a <path>` | Application only | none | Universal fallback |
| `tell application id "X" to activate` | Application only | Automation (per target app) | Equivalent to above, worse permissions |
| App's own `sdef` window command | **Specific window** | Automation (per target app) | **Recommended** where a dictionary exists |
| `System Events` → `perform action "AXRaise"` | Specific window, any app | Automation **+ Accessibility** | Silently fails — see §4 |

### 3.2 There is no single generic AppleScript incantation

The obvious app-agnostic-among-scriptable-apps move is the Standard Suite's writable `index`
property (`set index of window W to 1`). VERIFIED it is **not** portable:

- Terminal.app's `sdef` declares `window.index` (`pidx`, read/write, "ordered front to back"). Works.
- Ghostty declares a Standard Suite but its `window` class has only `id`, `name`, `selected tab` —
  no `index`, no `bounds`. VERIFIED:
  ```
  $ osascript -e 'tell application "Ghostty" to get index of first window'
  execution error: Ghostty got an error: Can't get index of window 1. (-1728)
  $ osascript -e 'tell application "Ghostty" to get properties of first window'
  id:tab-group-b92b6af80, name:herdr, selected tab:tab id tab-b937d0e00 ..., class:window
  ```

Ghostty instead ships a bespoke command. VERIFIED from `Ghostty.sdef`:

```xml
<command name="activate window" code="GhstAcWn" description="Activate a Ghostty window, bringing it to the front.">
  <direct-parameter type="specifier" description="The window to activate."/>
</command>
```

So window raising requires a **per-bundle-id adapter table**, not one script.

### 3.3 The activation test

One brief activation test was run, and focus was restored immediately afterwards. VERIFIED:

```
prior=Notion
afterActivateWindow=ghostty
restored=Notion
```

`tell application "Ghostty" to activate window w` both raised the window *and* brought the app
frontmost — no separate `activate` call needed. VERIFIED that Ghostty's dictionary works with
**Automation permission only**; no Accessibility grant existed on this machine (§4) and the call
still succeeded.

**Not proven: multi-window disambiguation.** Only one Ghostty window existed during the research, so
"raise window A while B also exists" is INFERRED from the sdef (`activate window` takes a window
specifier, and `whose name is` filtering was VERIFIED to work). This is the single most important
open question and should be re-tested with two windows before the spec is frozen.

### 3.4 Ghostty's dictionary, for the adapter table

VERIFIED classes/commands: `application` (`frontmost`, `front window`), `window` (`id`, `name`,
`selected tab`), `tab` (`id`, `name`, `index`, `selected`, `focused terminal`), `terminal` (`id`,
`name`, `working directory`, `command`, `environment variables`); commands `activate window`,
`select tab`, `focus`, `new window`, `new tab`, `split`, `input text`, `send key`, `close*`.

Note `terminal` exposes **no pid and no tty** — so there is no way to go pid → Ghostty window
directly. That is precisely the gap the title nonce fills.

### 3.5 AeroSpace

VERIFIED a tiling WM (`bobko.aerospace`, pid 887) is running on this machine. INFERRED that a tiling
WM may move windows between virtual workspaces such that "raised" does not mean "visible". Not
tested. Worth a note in the spec but not a blocker.

---

## 4. Permissions (TCC)

This is the part that decides the design.

### 4.1 Where the grant lands

VERIFIED, Stream Deck plugin process shape:

```
982   1   /Applications/Elgato Stream Deck.app/Contents/MacOS/Stream Deck --runinbk
1434  982 ~/Library/Application Support/com.elgato.StreamDeck/NodeJS/20.20.0/node --no-global-search-paths .../plugin.js -port 28196 ...
```

Plugins are direct children of the Stream Deck app, running a **bundled Node 20.20.0**. TCC
attributes to the responsible process, so every prompt and every entry in System Settings says
**"Elgato Stream Deck"** — the user will never see "sd-herdr". INFERRED (standard TCC responsible-
process attribution), but the process shape is VERIFIED.

VERIFIED, `Elgato Stream Deck.app` posture:

- Entitlements include `com.apple.security.automation.apple-events = true`; **no**
  `com.apple.security.app-sandbox`. Hardened runtime (`flags=0x10000`), Team `Y93VXCB8Q5`.
- `Info.plist` carries `NSAppleEventsUsageDescription = "A Stream Deck plugin wants to use
  AppleScripts."` and `LSUIElement = true`.

So Apple Events from a plugin are a supported, first-class path — Elgato explicitly provisioned for
it. Not sandboxed, so spawning `/usr/sbin/lsof` and `/usr/bin/osascript` is fine.

### 4.2 Automation prompts (survivable)

INFERRED: the first `osascript` targeting `System Events`, and separately the first one targeting
the terminal app, will each raise a **visible** "Elgato Stream Deck wants to control X" dialog.
Denial thereafter returns `-1743 errAEEventNotPermitted`. These are recoverable: the user sees them,
and the plugin can detect `-1743` and render a "needs permission" face.

VERIFIED that both grants already existed for the harness used here (`System Events` process query
and Ghostty dictionary calls both succeeded without a prompt), so the prompt itself was not
observed in this session.

### 4.3 Accessibility (the wall — do not depend on it)

VERIFIED, and this is the headline finding:

```
$ osascript -e 'tell application "System Events" to tell process "Ghostty" to get name of every window'
execution error: System Events got an error: osascript is not allowed assistive access. (-1728)
```

Two things matter here:

1. **It failed**, with `-1728`, despite Automation-to-System-Events being granted (the process-
   metadata query in §1.3 worked in the same session). UI-element access is a *separate* grant.
2. **No dialog appeared.** The call returned immediately, well inside a 15 s timeout. macOS did not
   offer to add the app to Privacy & Security → Accessibility. This is exactly the "permission wall
   the user never sees" from the ticket: `AXRaise`-based window raising would fail 100% of the time
   on a fresh install, with a cryptic AppleScript error and no user-facing remedy.

Accessibility cannot be requested programmatically from `osascript`, and there is no `Info.plist`
key for it — the user must manually add the app in System Settings. **Therefore: never build the
primary path on `System Events` UI scripting.** If it is offered at all, it must be an opt-in
"advanced" mode with explicit setup instructions.

---

## 5. Recommended mechanism

```
press
 │
 ├─ 1. herdr:  client.window_title.set { title: "⟪herdr:<session>:<nonce>⟫" }
 │        reason == "no_foreground_client"  ──▶  nothing to raise; stop. Render "detached".
 │
 ├─ 2. discover host app  (cached; see §5.1)
 │        a. lsof -U -F pcdn        → client pid(s) via peer-device correlation on herdr-client.sock
 │        b. ps -axo pid,ppid,command → walk ppid to the ancestor with ppid == 1
 │        c. osascript: System Events → application process whose unix id is <top>
 │                                    → { name, bundle identifier }
 │        no bundle id (-1719)  ──▶  go to 4 (fallback)
 │
 ├─ 3. raise, by bundle id, via the adapter table
 │        com.mitchellh.ghostty : tell app id ... to activate window (first window whose name is NONCE)
 │        com.apple.Terminal    : tell app id ... to set index of (first window whose name contains NONCE) to 1, then activate
 │        <unknown bundle id>   ──▶  go to 4
 │        no window matches NONCE ──▶ go to 4
 │
 ├─ 4. fallback:  open -b <bundleid>     (or `open -a` on the bundle path)
 │        raises the application, not a specific window. Good enough with one window.
 │        no bundle id at all ──▶ configured-fallback bundle id (§6)
 │
 ├─ 5. herdr:  client.window_title.clear
 │
 └─ 6. herdr:  agent focus <target>       (the #1 press contract)
```

### 5.1 Notes on the shape

- **Cache the host-app discovery**, keyed on the client pid, and invalidate when the client pid
  changes. Discovery costs 0.26 s (VERIFIED) — acceptable per press, but the `osascript` hop is the
  bulk of it and is worth skipping on the hot path.
- **Steps 1 and 5 bracket a mutation of the user's window title.** Keep the interval short. On any
  error between them, still issue `.clear` — a stranded nonce in the user's title bar is a visible
  bug.
- **Do the raise before the focus.** Raising is the slower, more failure-prone half; `herdr agent
  focus` is a local socket call. Also matches #1's stated ordering.
- **Every failure in steps 2–4 degrades, never throws.** The worst acceptable outcome is "the app
  came forward but the wrong window is on top". The unacceptable outcome is "nothing happened and
  the user does not know why" — so surface a distinguishable tile state when step 4 also fails.
- **Adapter table is data, not code.** A `Record<bundleId, RaiseStrategy>` with a default of
  `open -b` keeps the untested edge (per #1's test-seam decision) thin and lets unknown terminals
  degrade cleanly rather than being special-cased.

### 5.2 Consolidated failure modes

| Failure | Detection | Degradation |
|---|---|---|
| Session detached / no client | `reason == "no_foreground_client"` | Render "detached"; do not raise anything |
| Client inside tmux / zellij | Step 2c returns `-1719` | Configured-fallback bundle id (§6) |
| Client over SSH | Step 2c returns `-1719` | Out of scope per #1 |
| Unknown terminal (no sdef) | No adapter entry | `open -b` — app-level raise only |
| Terminal overwrote the nonce | No window matches title | `open -b` — app-level raise only |
| Automation denied by user | `-1743` from `osascript` | `open -b` (needs no TCC); render a "permission" hint |
| Accessibility not granted | `-1728`, **no prompt** | Never on the primary path — by design |
| Multiple clients on one session | `clientPids.length > 1` | Take the one herdr titled; else first; log |
| App has several windows and nonce failed | Cannot distinguish | Accepted: app-level raise |
| Tiling WM moved the window off-workspace | Not detectable | Accepted; document |

---

## 6. Documented degradation path: hardcoded Ghostty

When discovery cannot name a host application — the tmux/zellij case, an SSH-hosted client, or a
platform change that breaks the `lsof` correlation — fall back to a **configured bundle identifier**,
defaulting to `com.mitchellh.ghostty`.

- It is a **per-button setting** (mirroring the session-name setting in #1), not a constant. Name it
  something like `hostAppBundleId`, default `com.mitchellh.ghostty`, and let the user override it.
- Raising it is `open -b com.mitchellh.ghostty` (INFERRED from `open(1)`: `-b <bundle identifier>`
  is VERIFIED present in `open --help`). This requires **no TCC grant of any kind** — it is the one
  step in the whole design that cannot be permission-walled.
- It raises the **application**, not a window. With one Ghostty window (the situation on this
  machine, VERIFIED) that is indistinguishable from success.
- The fallback must be *visible*: if the plugin used it because discovery failed, say so somewhere
  (log line, or a distinguishable tile hint). A silent permanent fallback is how a broken walk goes
  unnoticed for months.

---

## 7. Open questions

1. **Multi-window targeting is unproven.** Only one Ghostty window existed. Re-test `activate window
   (first window whose name is NONCE)` with two or more windows before freezing the spec. (§3.3)
2. **Does herdr overwrite the nonce on its own events?** The title survived 24 s idle, but pane
   focus, cwd change, and agent status change were not provoked. If herdr re-asserts the title
   aggressively, the set→match window may be too narrow. (§2.3)
3. **Detached and `session attach` cases were not exercised** on a live session. Both are INFERRED.
4. **First-run Automation prompt behaviour from a Stream Deck plugin** was not observed (grants
   already existed here). Worth one clean-machine check, because a prompt that appears while the
   Stream Deck app is `LSUIElement` may not surface where the user expects.
5. **Does raising work under AeroSpace** when the target window is on another virtual workspace?

## Appendix: reproduction snippets

Discovery (Node, no dependencies) — the exact script that produced §1.4:

```js
// 1. lsof -U -F pcdn  → rows of { pid, cmd, dev, name }
// 2. devs/srv = rows where name === CLIENT_SOCK
// 3. clients  = rows where name === "->" + dev, dev ∈ devs, pid ∉ srv
// 4. ps -axo pid=,ppid=,command=  → walk ppid until ppid === 1
// 5. osascript: tell application "System Events" to tell
//      (first application process whose unix id is <top>)
//      to return (name & tab & bundle identifier)
```

Title probe:

```
echo '{"id":"1","method":"client.window_title.set","params":{"title":"NONCE"}}' | nc -U ~/.config/herdr/herdr.sock
osascript -e 'tell application id "com.mitchellh.ghostty" to get name of every window'
echo '{"id":"2","method":"client.window_title.clear","params":{}}'              | nc -U ~/.config/herdr/herdr.sock
```

Schema dump: `herdr api schema --output /tmp/hs.json` (251 KB; top-level keys `schemas.{request,
success_response, error_response, event, subscription_event}`).
