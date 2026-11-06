# sd-mux

A Stream Deck button that surfaces whether any agent in a
[herdr](https://github.com/ogulcancelik/herdr) session or a Rex session needs attention,
and on press walks you through them, one press per agent.

The herdr design is specified in [#17](https://github.com/sigma/sd-herdr/issues/17). The
two-backend design is in [#35](https://github.com/sigma/sd-herdr/issues/35), decided on
[map #29](https://github.com/sigma/sd-herdr/issues/29), and the choice to keep one project
is recorded in [ADR 0001](docs/adr/0001-one-plugin-two-backends.md). The vocabulary is in
[`CONTEXT.md`](CONTEXT.md).

## Install

macOS only, and it wants the Nix devShell — which also puts `node_modules/.bin` on `PATH`,
so `streamdeck`, `rollup`, `biome` and `vitest` are plain commands:

```sh
direnv allow          # or: nix develop 'path:.'
just install
just link             # builds, then `streamdeck link` the .sdPlugin
```

**Upgrading from sd-herdr:** the plugin is now `dev.yrh.sd-mux`, and Stream Deck treats a
new UUID as a new plugin. Keys placed under the old `dev.yrh.sd-herdr` stop working and must
be dragged on again; `streamdeck unlink dev.yrh.sd-herdr` removes the old link.

Then drag **sd-mux → Attention** onto a key. Out of the box that tile is a herdr tile: it
follows the herdr session named `default` and starts painting within a poll, with nothing to
configure and no `herdr` binary involved — the plugin talks to the session's unix socket
directly, which matters because `herdr` is *not* on a plugin's `PATH`
([why](docs/research/plugin-runtime-environment.md)). A Rex tile needs one setting, below.

### herdr setup

What it needs is a herdr **server** with a session actually running — everything here is
verified against herdr 0.8.0 / protocol 19. Until there is a session to connect to, the tile
sits grey, which is the first thing to check if it never turns any other colour.

### Rex setup

Rex needs the Rex server running, the Rex app connected to it, and one setting.

- **The Rex server.** The plugin connects to its control socket at
  `~/Library/Application Support/rex/server.sock`, derived from the home directory, because
  Rex's own `REX_SERVER` variable is not in a plugin's environment
  ([control API](docs/research/rex-control-api.md) §7). Verified against Rex server
  `0.0.1793890641-gaf0c20`, API revision 11. The plugin pins revision 11 at both ends, so a
  server that cannot speak it refuses the connection and the tile stays grey (the API's
  documented behaviour; not exercised here).
- **The Rex app**, connected to that server. The press uses the app to show the agent's tab;
  see [On Rex](#on-rex). With no app connected the press still focuses the agent on the
  server and runs `open -b`, and what that shows is not tested.
- **A session, chosen in the inspector.** Set **Backend** to Rex and pick the session from
  the list. An unconfigured Rex tile stays grey, because the plugin cannot tell which session
  the app is showing ([why](docs/research/rex-displayed-session.md)).

### Settings

Each button has a **Backend**, and then the fields for that backend. All are optional.

| Setting | Backend | Default | What it does |
| --- | --- | --- | --- |
| **Backend** (`backend`) | — | herdr | herdr or Rex (stored as `rex`). Any other value, or none, is herdr, so a key placed before Rex existed is herdr. |
| **Session** (`sessionName`) | herdr | `default` | The herdr session this button speaks for. |
| **Terminal app** (`hostAppBundleId`) | herdr | `com.mitchellh.ghostty` | Bundle id of the terminal hosting that session. Used **only** as the last-resort input to the raise. |
| **Session** (`sessionId`) | Rex | none | The Rex session this button speaks for, picked from the live sessions. Stored by `session_id`. |

**One tile speaks for exactly one session**, on either backend — that is what keeps a single
colour meaningful. Watching a second session means a second button, and the two operate
independently. Two buttons pointed at the *same* session cost one poll, not two, and share
one walk through the attention set: they are two views of the same cycle.

**herdr.** Renaming the session re-resolves the socket and resets the cycle. A session that
is not running renders exactly the same grey as an unreachable socket — one "cannot see
anything" state, not two.

**herdr's Terminal app** is only consulted when the plugin cannot work out for itself which
application hosts the session — inside tmux or zellij, or over SSH — and never on a machine
running a supported window manager. Because a wrong value there produces a confidently
wrong raise, its use is never silent: the key flashes on every press that falls back to it
(see [On herdr](#on-herdr)).

**Rex.** The session list comes from the Rex server. The inspector asks for it when it opens
on a Rex tile and when you switch **Backend** to Rex, and holds the connection only for that
request. Sessions are listed by label; where two share a label, the list adds the id to tell
them apart, and a session with no label is listed by its id. The stored choice is always shown,
so a server that is down does not make the tile forget it: a session that is gone reads
`missing session (<id>)`, and with Rex down the choice reads `<id> (Rex is not running)`. With
nothing stored, the list opens on `Choose a session…`, or says `No Rex sessions` or
`Rex is not running`.

**The Rex choice is stored by id, not label.** Rex renames sessions on its own, and labels are
not unique, so a tile that followed a label would drift or pick up the wrong session. Renaming
a session in Rex keeps its tile.

## The face

The tile is a coloured nameplate, a body line, and a row of pips. It polls the session once
a second, so a change on the server reaches the face about a poll later.

**The plate carries the state colour**, which is the tier of the most urgent agent in the
session. The rows below are in that priority order, most urgent first:

| Colour | Means |
| --- | --- |
| **red** | some agent is `blocked` — stopped, waiting on you |
| **green** | nothing is blocked, and some agent is `done` — finished, unread |
| **amber** | neither of those, and some agent is `working` — running, somewhere to check on |
| **dark** | nothing is waiting |
| **grey** | **the tile cannot see the session** |

The three urgent colours read as a traffic light — red stopped, amber running, green
arrived — but that is what each colour *says*, not how they rank. `done` outranks
`working`: a finished agent is owed an answer, a running one is only somewhere to look.

**Grey is not "all clear" — dark is.** This is the single most important thing not to
misread on this tile. Grey says the plugin has nothing it trusts to show you: the socket or
server is unreachable, the session is stopped, the last snapshot has aged past 3 s, a server
lifetime boundary is still settling (herdr holds grey for 4 s across one; Rex does not hold),
or every agent it can see reports `unknown` (herdr only: Rex has no `unknown`). On Rex, a tile
with no session chosen is grey from the start, and one whose session has been destroyed goes
grey at the 3 s deadline, as for any failed poll. All of those collapse into one colour with one plate deliberately,
because they are one statement — *ask somewhere else* — and splitting them would invite reading
a lighter grey as a milder problem. Failures back off to a 5 s ceiling and recover on their own;
grey clears itself when the session comes back.

**The plate's text names the session.** On herdr it is the session name, clipped with an
ellipsis rather than shrunk to fit — a name at 5px is unreadable, and so fails the tile's
only job. A session named `default` renders **`herdr`**, since `default` is herdr's
placeholder rather than a name anyone chose. On Rex it is the session's label. Rex may change
that label itself, so the plate can change without you touching anything; a Rex session with
no label renders **`rex`**. A grey tile always reads its backend's name, `herdr` or `rex`,
whatever the session is called: grey is one state, and a plate that varied by cause would split
on the face what the colour joins.

**The body names where the *next press* goes** — not the most urgent agent. Those differ,
and the body deliberately follows the button: focusing a `blocked` agent consumes nothing,
so a body naming the head of the set would sit unchanged across a whole cycle and never
answer the one question a press is about. The body changing as you step *is* the
cycle-position indicator; there is no other one.

So **the bar and the body are allowed to disagree about tier**, and a red bar over a body
naming an amber-tier agent is correct rather than a bug. The bar is global — it is the only
element left saying "something is blocked *somewhere*" once the cycle has stepped past it.
Colour is never solely load-bearing: the text survives greyscale.

The body is the target's **group label** — the workspace on herdr, the window on Rex — plus
**a position index**, ①, ②, ③, when, and only when, another agent in the attention set shares
its tab. A plain shell alongside the target adds no index,
because the press can still only go to one agent and the label is already unambiguous.

On herdr the index counts *every* pane in the tab, agent or shell, in geometric order, so an
`agent | shell | agent` tab reads ① and ③: the number names what is on screen, which is the
only thing you can check it against. On Rex it counts every block of the window's tiled layout,
agent or shell, in the same `(y, x)` order. A floating block sits over the tab and is not
counted: it is still attention, and colours the tile and the pips, but as a target its body is
the bare window label. The index blinks — consume the sibling and the body goes back to a bare
label. A Rex press consumes nothing, so there the index stays until the sibling leaves the
attention set (goes `idle` or closes).

The window label on Rex is the name someone gave the window. A window nobody named, one whose
label is empty or is still Rex's default (`Window` and the last eight characters of its id), is
labelled from an agent's terminal title instead, the focused block's first. With no titled
agent it keeps the default label, or shows its id if it has no label at all
([the default label rule](CONTEXT.md#rex)).

**The pips are the other waiters**, tier-coloured, in the same priority order, capped at
four and then `…`. The agent the body names never gets a pip, so the body and the pips
never restate each other.

## The press

A press focuses one agent — its pane on herdr, its block on Rex — so that it is immediately
typeable, and then brings the window that shows it forward. The raise is different on each
backend, so each has its own section below. The next press goes to the highest-priority
attention agent this cycle has not shown yet, and so on until the set is spent, at which point
the cycle wraps to the top. Stepping is per *agent*, so two agents tiled in one tab each get
their own press — though on herdr a single press can still *consume* several `done` agents at
once, which is the first herdr cost below.

The visited set is pruned rather than reset: an agent arriving mid-cycle is reachable without
restarting the walk. It resets on exactly three things — a wrap, the last button on that
session going away, and a detected server restart. There is deliberately no idle-timeout reset.

Pressing while grey focuses nothing, deliberately: the tile has already said it does not trust
its data, so it will not act on it. A dark tile has nothing to focus either. On herdr either
press still runs the raise and nothing else. On Rex it still asks the app to show the session,
without a window, and brings Rex forward.

### On herdr

The raise is a four-rung ladder — window manager, then AppleScript to the terminal by
bundle id, then `open -b`, then decline. **The order is chosen for TCC, not for accuracy**:
rung 1 needs no permission grant of any kind, so a user with a supported window manager is
never shown a security dialog by this plugin at all.

**The key flashes on exactly two things**: a raise that did not end in the *one* right
window, and a raise that had to fall back to the **Terminal app** setting — even one that
otherwise succeeded, because that is the one rung that cannot check its own target. It
never shows on the face, because a raise outcome is per-press and the face is session
state.

### On Rex

A Rex press is three steps: two on the plugin's existing control connection, then one `open`.
None needs a permission grant, and none marks a window: there is no nonce to write or clear
([research](docs/research/rex-raise.md)).

1. **Focus** the agent's block on the server. The plugin reads the session's view to find the
   window holding the block, then calls `session.focus_block`; the window is remembered for
   step 2. A block that closed since the poll fails here, the tile re-reads the snapshot, and
   steps 2 and 3 still run, without a window.
2. **Select** the session and that window on the local Rex app: the connected client of kind
   `app` on the unix socket, found with `client.list`, is sent `client.perform` with action
   `session.select`. This is what shows the agent's tab: the server's own active window does
   not move the app, so this step is needed. With no such client the step is skipped.
3. **Bring Rex forward** with `open -b com.superlogical.rex`, whatever step 2 did.

**The key flashes on a Rex press only when step 2 fails** (listing the clients or the select
returns an error, including the app not answering within the 2 s the select allows it) **or
step 3 fails.** So a grey press while the server is down flashes, since step 2 cannot be sent,
and still opens Rex. A skipped step 2 does not flash, so a press with no app connected focuses
the agent and opens Rex without showing its tab, and nothing on the key says so. That is the
one place the Rex press is silent about a shortfall.

A press onto a Rex agent in a window other than the one the app shows changes the app's tab to
that window's. Several Rex windows were not tested: which window the select drives, and whether
`open -b` fronts that one.

## Accepted costs

The costs below are intended and will not be fixed. Each of them looks like a bug from the
outside, which is why they are written down here.

### On both backends

**Keys placed before the rename must be placed again.** The plugin has a new UUID, so the
upgrade note above is the whole of the fix: every existing user pays this once.

### On herdr

**A second `done` agent in the same tab is unreachable by button.** Focusing any pane calls
herdr's "mark the active tab seen", which clears `seen` for *every* pane in that tab — so
one press consumes every `done` agent there, and its neighbour never gets its own press.
The face gives no warning, because there is nothing you could have done differently. A
tab's panes are visible together, so consuming them together is precision rather than
over-reach. `blocked` agents are unaffected: `blocked` is a reported state, not `idle +
!seen`. This cost does not apply on Rex, where focus changes no status.

**A live handoff silently consumes the `done` tier, and this is the one case where the tile
is confidently dark while you are still waiting.** When herdr hands its panes over to a new
server without killing them, it re-detects the agents from each pane's foreground process
and seeds them `Idle`. An agent that was `done` therefore comes back as plain `idle` and
stays there — nothing remains on screen to rescan, and the plugin has no lever to pull. The
tile settles to dark, honestly reporting what herdr now says, which is not what is true.
(A stop/restart is different: it kills the agents, so the panes really are empty shells and
the dark tile afterwards is simply correct.) Either way the tile holds grey for 4 s across
the boundary rather than flashing a face it would have to take back.

**A stranded nonce.** Each press writes a marker into herdr's `client_window_title` so the
raise can find the right window among every window on the machine, and clears it
immediately afterwards. If the herdr client dies in between, the clear answers
`no_foreground_client` and the marker stays in the title bar permanently. It reads

```
sd-mux raise <session> #<n>
```

rather than a hex blob for exactly this reason: the person who has to remove it is you.
Clearing it is manual — restart the herdr client. Recovering it automatically is
deliberately out of scope for v1.

**A declined raise under a tiling window manager is a choice, not a failure.** If the
window manager is present but cannot find the marked window, the press declines rather than
trying the rungs below it — no AppleScript, and so no Automation dialog on a machine
running a window manager, and no `open -b`. That last call is *deterministically wrong*
under a tiler: it fronts a window on the workspace you are already looking at, which looks
like success and is not. And the press's focus has already happened, so the session did
move; only the window did not follow. The key flashes to say so.

### On Rex

**Green lasts until the agent's next turn.** A press does not consume `done`. Rex keeps a
`done` record until the program reports again; focusing the block, pressing keys into it, or
showing the session changes nothing ([program status](docs/research/rex-program-status.md) §1).
So after a press onto a `done` agent the tile stays green, and the body moves on to the next
agent. The cycle walks each `done` agent once and then wraps, the same way it walks `blocked`
ones. The green clears when the agent starts its next turn. The Rex app may hide its own done
markers once they have been seen; that is not verified, and the tile follows the server, not the
app ([§6](docs/research/rex-program-status.md#6-not-measured)).

**No `done` survives a Rex restart, and nor does any agent.** A Rex server restart kills the
terminal processes and drops every program status record. Session, window and block ids survive,
but nothing comes back, so an agent that was `done` and unseen at the restart is gone afterwards
and the tile goes dark. That dark is honest, and there is no repopulation to hold grey through
([restart](docs/research/rex-server-restart.md)).

**A Rex tile must be configured, and it cannot follow the session the app is showing.** The
Rex API reports no displayed session, so a tile with no session chosen stays grey rather than
guessing one ([displayed session](docs/research/rex-displayed-session.md)). The choice is stored
by id, so it survives renames, but the tile cannot be pointed at "whatever I am looking at".

## The Automation prompt (herdr)

This section is about herdr's raise. The Rex press sends no Apple Event, so it never raises
this dialog.

**Only on a machine with no supported window manager.** With AeroSpace present the plugin
never sends an Apple Event, so none of this applies.

Everywhere else, the first press may raise a system dialog asking permission to control
another application — expect it to name **"Elgato Stream Deck"**, not sd-mux, and to
carry Elgato's own purpose string:

> A Stream Deck plugin wants to use AppleScripts.

That is not a mistake and it is not another app asking. A `.sdPlugin` is a plain directory
with no bundle id and no signature — it has **no code identity of its own** for macOS to
name, so a plugin's permissions are expected to be asked for, and held, under the Stream
Deck app's name; Elgato worded that string as they did for exactly that reason. Expected,
because it is a strongly-supported inference rather than a measured fact: the prompt has
not been seen from a real plugin here, and the plugin reaches AppleScript through
`osascript`, whose own permission handling is the one piece the research could not pin
down. If the dialog you get names something else, that is the open question resolving, not
a different app.
([The measurements, and what is still unverified](docs/research/macos-automation-prompt.md).)

**There may be two dialogs, for two different targets.** Before the plugin can script your
terminal it has to work out *which* application it is, and it asks **System Events** —
a separate target, so a separate prompt and a separate row under Automation. Permission is
per (app, target) pair, which is also why:

- **The grant is Stream-Deck-wide.** Allowing it lets *every* installed Stream Deck plugin
  automate that terminal — and conversely, a grant you gave some other plugin for Spotify
  is not a grant for your terminal.
- **A denial is permanent.** macOS never re-prompts for the same pair; every later attempt
  fails the same way, and the plugin can only fall through to a weaker rung and tell you
  where to go. It cannot ask again.
- **Where to go is** System Settings › Privacy & Security › **Automation**, under *Elgato
  Stream Deck*.

If you deny it, the press still works — it degrades to activating the application rather
than raising the specific window, and flashes the key to say the outcome was not exact.

## Development

`just` alone lists the recipes. The gate is `just ci` — `lint`, `typecheck`, `test`,
`build` — which is exactly what `.github/workflows/ci.yml` runs. `just lint` is biome in
**check** mode, so it fails on unformatted sources rather than rewriting them; `just fmt`
is the one recipe that writes. `just dev` watches and hot-reloads; `just logs` tails the
plugin log.

### Layout

```
src/core/        the seam: reduce(state, event) -> {state, effects} and face(state),
                 the neutral snapshot, and the Backend record each backend supplies
src/face/        the FaceDescriptor and its SVG renderer (pure, unit-tested)
src/herdr/       herdr: the NDJSON socket client, where a session's socket lives,
                 and the conversion of herdr's snapshot to the neutral one
src/rex/         Rex: the control WebSocket, the poll, the conversion, the press,
                 and the session list the inspector shows
src/raise/       herdr's four-rung raise ladder, and the subprocess runner both
                 backends use (`open -b` for Rex)
src/actions/     the Stream Deck action — the only SDK-coupled code; it picks a
                 hub by the button's backend
src/testing/     test-only access to the fixture corpus
src/plugin.ts    the entry point
fixtures/        herdr snapshots, and Rex views under rex/, each with its provenance
dev.yrh.sd-mux.sdPlugin/     the manifest, the property inspector and images;
                             bin/ is built, not committed
```

All policy lives in `src/core/`, and it is pure: it never reads a clock (every event
carries its own timestamp) and never calls anything (effects come back as data for the
runner to obey). That is what lets a test assert a one-second poll cadence without
sleeping, and it is the seam every ticket builds against. The core sees a backend only
through the neutral snapshot and its `Backend` record (three constants and the plate rule
`plateFor`), so a backend's wire format never reaches the policy.

The plugin's marketplace icon must be a PNG (the manifest validator rejects an SVG for
that one field). `imgs/plugin/marketplace{,@2x}.png` are rasterized from the checked-in
`marketplace.svg` with `resvg`, at 288×288 and 576×576.

## Manual verification

Three things at the edge hold no policy and are **deliberately untested in CI**: the socket
clients' real I/O (herdr's and Rex's), the subprocess runner under `src/raise/`, and the
Stream Deck SDK binding. Each of them is a thin translation to something CI does not have — a
live herdr or Rex server, a window manager, a physical key — so a test double would assert only
that the double behaves like itself. They are verified by hand instead, on the procedure below.

Steps 1 and 2 are shared. Run them after any change to the manifest or `src/plugin.ts`. Run the
herdr steps after any change under `src/herdr/client.ts`, `src/raise/spawn.ts`, `src/actions/`,
`src/plugin.ts`, or the manifest, and the Rex steps after any change under `src/rex/client.ts`,
`src/rex/press.ts`, `src/raise/spawn.ts`, `src/actions/`, `src/plugin.ts`, or the manifest — and
record what you measured, replacing the results beneath it.

1. **`just validate`** — the manifest and bundle pass `streamdeck validate`.
2. **`just link`**, then watch `just logs` — the plugin process starts and completes SDK
   registration (the `RegistrationParameters` handshake).

### herdr

3. **Socket path and connection.** Compare the plugin's resolved path against a live
   `herdr session list --json`, and confirm the plugin connects from inside the Stream Deck
   process, with no `herdr` binary on `PATH`.
4. **Round-trip latency.** Time a `session.snapshot` against a real, populated session.
5. **The tracer bullet.** With the button on a key, mark a pane `blocked` and time the red
   paint; release it and time the return to dark. The painted descriptor is logged at debug
   level, which is how these are timed.
6. **First paint after a plugin restart** — grey, then a face backed by real data.
7. **The window-manager rung's listing format** is still what the parser expects:
   `aerospace list-windows --monitor all --format '%{window-id} %{window-title}'`, one
   `<id> <title>` line per window, ids without spaces, an untitled window still emitting
   its trailing separator.
8. **One real press, end to end** — nonce written, pane focused, window raised, nonce
   cleared. This mutates a live herdr session, so use a scratch session rather than the one
   you are working in.

Recorded results — herdr. Stream Deck app 7.4.2 / macOS 26.5.2, herdr 0.8.0 / protocol 19:

- (1), (2) pass; step 2 checked against a connected Stream Deck XL.
- The five state colours (`red`, `amber`, `green`, `dark`, `grey`) rasterize as expected at
  72×72 — checked by rendering the SVGs offline, *not* on the device.
- (3) passes for `default`.
- (4) ~110 ms against a live 7-agent session.
- (5), 2026-08-17: `pane.report_agent` marked a pane `blocked` at `20:16:57.445` and the
  plugin painted red at `20:16:58.082` — **637 ms**. `pane.release_agent` at `20:17:00.603`,
  dark again at `20:17:01.405` — **802 ms**. Both land on the next poll, so the worst case
  is a full poll interval plus the round trip.
- (6) grey at `20:16:54.641`, dark at `20:16:54.749` — **108 ms** to a face backed by real
  data, since there is nothing to resolve first.
- (7) checked against AeroSpace 0.21.3-Beta over 13 live windows.

**Not yet done by hand, herdr:** step 8; placing the key on the device and confirming the painted
face with human eyes; and rungs 2 and 3 on a machine with no window manager, including
the Automation prompt's rendered wording — the residual `[U]`s in
[the research](docs/research/macos-automation-prompt.md#9-hitl-checklist--the-clean-account-probe).

### Rex

3. **First paint.** A key set to Rex with no session chosen is grey. Choose a session with no
   agents and it goes dark. Rename the session in Rex: the plate follows the new label and the
   tile stays on the same session.
4. **Socket and handshake.** After the first session is chosen, `just logs` shows the
   `rex, api revision N` line the plugin writes once it has connected. The plugin does not log
   the path it used, so confirm that `rex server status` reports
   `~/Library/Application Support/rex/server.sock`, the path the plugin derives, and that the
   plugin needed no Rex environment variable to find it.
5. **The tracer bullet.** Make an agent block `blocked` (Claude Code asking a question does this)
   and time the red paint from the logged `face` line. Answer it and time the amber. Let the turn
   end and time the green. Each should land on the next poll, plus the round trip.
6. **The press lands on the agent.** Put the agent in a window other than the one the Rex app is
   showing, and press. The app should switch to that window's tab, Rex should come forward, and
   the agent should be where typing goes. The last part is not verified: the research did not
   check where typed input lands.
7. **No Automation prompt.** Throughout step 6, no macOS dialog appears, and System Settings ›
   Privacy & Security › Automation gains no row from the press.
8. **Green lasts.** Press onto a `done` agent. The tile stays green and the body moves on, and
   the green clears only at that agent's next turn.
9. **No app connected.** Quit the Rex app and press. Record whether Rex opens, whether any tab
   shows, and whether the key flashes. The code says it will not flash here; this has not been
   run on a device.
10. **Server restart.** Stop and start the Rex server. The tile goes grey once it has been down
    for the 3 s deadline (a quick restart, ~80 ms in the research, may never show grey), and
    settles dark once it is back, with no `done` left. Note how long the dark takes to return.
11. **Several windows.** With two Rex windows open, check that a press shows the tab in the window
    it aimed at, and that `open -b` fronts that window. If it fronts the other one, the Rex press
    is wrong for that layout and this section needs changing.

Recorded results — Rex: none yet. The Rex wire behaviour was measured against a live server in
[the research notes](docs/research/rex-control-api.md), but nothing above has been run on a device
with the plugin.
