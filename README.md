# sd-herdr

A Stream Deck button that surfaces whether any agent in a
[herdr](https://github.com/ogulcancelik/herdr) session needs attention, and on press walks
you through them, one press per agent.

The design is specified in [#17](https://github.com/sigma/sd-herdr/issues/17); the
vocabulary it is argued in is [`CONTEXT.md`](CONTEXT.md).

## Install

macOS only, and it wants the Nix devShell — which also puts `node_modules/.bin` on `PATH`,
so `streamdeck`, `rollup`, `biome` and `vitest` are plain commands:

```sh
direnv allow          # or: nix develop 'path:.'
just install
just link             # builds, then `streamdeck link` the .sdPlugin
```

Then drag **herdr → Attention** onto a key. That is the whole setup: out of the box the
tile follows the herdr session named `default` and starts painting within a poll, with
nothing to configure and no `herdr` binary involved — the plugin talks to the session's
unix socket directly, which matters because `herdr` is *not* on a plugin's `PATH`
([why](docs/research/plugin-runtime-environment.md)).

What it does need is a herdr **server** with a session actually running — everything here
is verified against herdr 0.8.0 / protocol 19. Until there is a session to connect to, the
tile sits grey, which is the first thing to check if it never turns any other colour.

### Settings

Two, both in the property inspector, both optional:

| Setting | Default | What it does |
| --- | --- | --- |
| **Session** | `default` | The herdr session this button speaks for. |
| **Terminal app** | `com.mitchellh.ghostty` | Bundle id of the terminal hosting that session. Used **only** as the last-resort input to the raise. |

**One tile speaks for exactly one session** — that is what keeps a single colour
meaningful. Watching a second session means a second button, and the two operate
independently. Two buttons pointed at the *same* session cost one poll, not two, and share
one walk through the attention set: they are two views of the same cycle.

Renaming the session re-resolves the socket and resets the cycle. A session that is not
running renders exactly the same grey as an unreachable socket — one "cannot see anything"
state, not two.

**Terminal app** is only consulted when the plugin cannot work out for itself which
application hosts the session — inside tmux or zellij, or over SSH — and never on a machine
running a supported window manager. Because a wrong value there produces a confidently
wrong raise, its use is never silent: the key flashes on every press that falls back to it
(see [The press](#the-press)).

## The face

The tile is a coloured nameplate, a body line, and a row of pips. It polls the session once
a second, so a change in herdr reaches the face about a poll later.

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
misread on this tile. Grey says the plugin has nothing it trusts to show you: the socket is
unreachable, the session is stopped, the last snapshot has aged past 3 s, herdr restarted
under it and it is holding for 4 s, or every agent it can see reports `unknown`. All of
those collapse into one colour with one plate deliberately, because they are one statement
— *ask somewhere else* — and splitting them would invite reading a lighter grey as a
milder problem. Failures back off to a 5 s ceiling and recover on their own; grey clears
itself when the session comes back.

**The plate's text is the session name**, clipped with an ellipsis rather than shrunk to
fit — a name at 5px is unreadable, and so fails the tile's only job. A session named
`default` renders **`herdr`**, since `default` is herdr's placeholder rather than a name
anyone chose.

**The body names where the *next press* goes** — not the most urgent agent. Those differ,
and the body deliberately follows the button: focusing a `blocked` agent consumes nothing,
so a body naming the head of the set would sit unchanged across a whole cycle and never
answer the one question a press is about. The body changing as you step *is* the
cycle-position indicator; there is no other one.

So **the bar and the body are allowed to disagree about tier**, and a red bar over a body
naming an amber-tier agent is correct rather than a bug. The bar is global — it is the only
element left saying "something is blocked *somewhere*" once the cycle has stepped past it.
Colour is never solely load-bearing: the text survives greyscale.

The body is the target's **workspace label**, plus **a pane index** — ①, ②, ③ — when, and
only when, another agent in the attention set shares its tab. A plain shell alongside the
target adds no index, because the press can still only go to one agent and the label is
already unambiguous. The index counts *every* pane in the tab, agent or shell, in geometric
order, so an `agent | shell | agent` tab reads ① and ③: the number names what is on screen,
which is the only thing you can check it against. The index blinks — consume the sibling
and the body goes back to a bare label.

**The pips are the other waiters**, tier-coloured, in the same priority order, capped at
four and then `…`. The agent the body names never gets a pip, so the body and the pips
never restate each other.

## The press

A press focuses one agent's pane — workspace, tab and pane in one call, so it is
immediately typeable — and raises the host terminal's window. The next press goes to the
highest-priority attention pane this cycle has not shown yet, and so on until the set is
spent, at which point the cycle wraps to the top. Stepping is per *pane*, so two agents
tiled in one tab each get their own press — though a single press can still *consume*
several `done` agents at once, which is the first accepted cost below.

The visited set is pruned rather than reset: an agent arriving mid-cycle is reachable
without restarting the walk. It resets on exactly three things — a wrap, the button going
away, and a detected herdr restart. There is deliberately no idle-timeout reset.

Pressing while grey raises the window and focuses nothing, deliberately: the tile has
already said it does not trust its data, so it will not act on it.

The raise is a four-rung ladder — window manager, then AppleScript to the terminal by
bundle id, then `open -b`, then decline. **The order is chosen for TCC, not for accuracy**:
rung 1 needs no permission grant of any kind, so a user with a supported window manager is
never shown a security dialog by this plugin at all.

**The key flashes on exactly two things**: a raise that did not end in the *one* right
window, and a raise that had to fall back to the **Terminal app** setting — even one that
otherwise succeeded, because that is the one rung that cannot check its own target. It
never shows on the face, because a raise outcome is per-press and the face is session
state.

## Accepted costs

Four behaviours below are intended and will not be fixed. Each of them looks like a bug
from the outside, which is why they are written down here.

**A second `done` agent in the same tab is unreachable by button.** Focusing any pane calls
herdr's "mark the active tab seen", which clears `seen` for *every* pane in that tab — so
one press consumes every `done` agent there, and its neighbour never gets its own press.
The face gives no warning, because there is nothing you could have done differently. A
tab's panes are visible together, so consuming them together is precision rather than
over-reach. `blocked` agents are unaffected: `blocked` is a reported state, not `idle +
!seen`.

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
sd-herdr raise <session> #<n>
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

## The Automation prompt

**Only on a machine with no supported window manager.** With AeroSpace present the plugin
never sends an Apple Event, so none of this applies.

Everywhere else, the first press may raise a system dialog asking permission to control
another application — expect it to name **"Elgato Stream Deck"**, not sd-herdr, and to
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
src/core/        the seam: reduce(state, event) -> {state, effects} and face(state)
src/face/        the FaceDescriptor and its SVG renderer (pure, unit-tested)
src/herdr/       the NDJSON socket client, and where a session's socket lives
src/raise/       the four-rung raise ladder, and the subprocesses it spawns
src/actions/     the Stream Deck action — the only SDK-coupled code
src/testing/     test-only access to the fixture corpus
src/plugin.ts    the entry point
fixtures/        captured and hand-derived herdr snapshots, each with its provenance
dev.yrh.sd-herdr.sdPlugin/   the manifest, the property inspector and images;
                             bin/ is built, not committed
```

All policy lives in `src/core/`, and it is pure: it never reads a clock (every event
carries its own timestamp) and never calls anything (effects come back as data for the
runner to obey). That is what lets a test assert a one-second poll cadence without
sleeping, and it is the seam every ticket builds against.

The plugin's marketplace icon must be a PNG (the manifest validator rejects an SVG for
that one field). `imgs/plugin/marketplace{,@2x}.png` are rasterized from the checked-in
`marketplace.svg` with `resvg`, at 288×288 and 576×576.

## Manual verification

Three things at the edge hold no policy and are **deliberately untested in CI**: the socket
client's real I/O, the subprocess runner under `src/raise/`, and the Stream Deck SDK
binding. Each of them is a thin translation to something CI does not have — a live herdr
server, a window manager, a physical key — so a test double would assert only that the
double behaves like itself. They are verified by hand instead, on the procedure below.

Run it after any change under `src/herdr/client.ts`, `src/raise/spawn.ts`,
`src/actions/`, `src/plugin.ts`, or the manifest — and record what you measured, replacing
the results beneath it.

1. **`just validate`** — the manifest and bundle pass `streamdeck validate`.
2. **`just link`**, then watch `just logs` — the plugin process starts and completes SDK
   registration (the `RegistrationParameters` handshake).
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

Recorded results — Stream Deck app 7.4.2 / macOS 26.5.2, herdr 0.8.0 / protocol 19:

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

**Not yet done by hand:** step 8; placing the key on the device and confirming the painted
face with human eyes; and rungs 2 and 3 on a machine with no window manager, including
the Automation prompt's rendered wording — the residual `[U]`s in
[the research](docs/research/macos-automation-prompt.md#9-hitl-checklist--the-clean-account-probe).
