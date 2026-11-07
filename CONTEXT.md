# sd-mux

A Stream Deck button that surfaces whether any agent in a [herdr](https://github.com/ogulcancelik/herdr)
session or a Rex server needs attention, and on press takes the user to the most urgent one. This
glossary is the vocabulary the design decisions on
[map #1](https://github.com/sigma/sd-herdr/issues/1) and
[map #29](https://github.com/sigma/sd-herdr/issues/29) are argued in.

It has three layers. The **neutral layer** is shared by every backend and uses only backend-neutral
words. **herdr** and **Rex** each hold the terms of one backend. A term from one backend's section
does not appear in the other's. The neutral layer names a backend's object only inside a parenthesis
that says what the backend maps the term onto.

## Neutral layer

**Backend**:
A multiplexer the plugin speaks to: herdr or Rex. A tile speaks to one backend, for one session on
it. The core reads four things about a backend and nothing else: the name it paints on grey
(`name`), whether a press writes a window marker (`marksWindow`), how long a restart holds grey
(`settleMs`), and the plate for a live session (`plateFor`).
Everything else a backend does is an adapter the runner calls.
_Avoid_: provider, driver.

**Session**:
The unit of work a tile watches: a herdr session, or a whole Rex server with every session in it.
One tile speaks for exactly one session — that is what keeps the face's single colour meaningful —
so watching two herdr sessions means two buttons.

**Session key**:
The opaque string a backend looks a session up by. Only the backend can read it. herdr's is the
socket path; Rex's is the server's socket path, so every Rex tile has the same one. Two tiles with
equal keys are the same session, so they share one poll loop and one cycle (see **Poll loop**).
Sharing follows the key, never the name a user typed.
_Avoid_: session name (the configured name is an input to the key, not the key).

**Lifetime marker**:
A set of witnesses, each a key with a token. A token is stable within one server lifetime and changes
across one. The core reads a changed token under a key present in both snapshots as a restart. A
backend that cannot say sends no witnesses, and then no restart is ever read from it. herdr has one
witness per pane; Rex has one for the whole server.
_Avoid_: instance id, generation (each names one backend's witness rather than the concept).

**Server lifetime**:
One run of a backend's server for a session. The topology survives across lifetimes; agent identity
does not, and no backend restores it. A lifetime ends at a restart. A backend may also end one in a
way that keeps its agents running (herdr's live handoff, below). The lifetime marker is how the core
notices the boundary.

**Agent**:
A unit the backend reports as hosting a coding agent, and the unit a press focuses: a pane on herdr,
a terminal block on Rex. Only agents are attention. A plain shell, or a block that is not an agent,
never enters the attention set.
_Avoid_: process, job.

**Agent status**:
One of `idle | working | blocked | done | unknown`, as the core reads it. `idle` is already looked at,
`blocked` is stopped and waiting on the user, `working` is running, `done` is finished, and `unknown`
is an agent the plugin cannot read. Which of these a backend can report (Rex never reports
`unknown`), and whether focusing an agent clears `done`, are backend-specific. See the herdr and Rex
sections.

**Group**:
The unit a user recognises a piece of work by, which the body names. herdr's group is the workspace;
Rex's is the window. With no label from the backend, the body names the group's id.
_Avoid_: workspace (herdr's word), project.

**Tab**:
The set of agents a press reveals together. herdr's tab is one; Rex's window is one, and on Rex it is
also the group. Agents sharing a tab are visible together, which is what **Attention sibling**
depends on.

**Attention set**:
The agents the button is speaking for: `blocked` ∪ `done` ∪ `working` ∪ (`unknown` with an agent).
`idle` is the only status left out — it means "already looked at, no follow-up", so there is nothing
to walk to. A `working` agent is owed no answer, but it is somewhere to *check on*, and the cycle
reaches it once everything more urgent is spent.
_Avoid_: queue, backlog, alerts, notifications.

**Priority order**:
The total order over the attention set: tier `blocked` → `done` → `working` → `unknown`, then lowest
wait key first within a tier, so the longest-waiting agent wins. Each backend supplies its own wait
key; the core never reads it as a time.

**Top-priority agent**:
The head of the attention set under priority order, ignoring the visited set. Stable — and *not* what
the tile names ([#12](https://github.com/sigma/sd-herdr/issues/12)). It survives only as the thing the
state colour speaks for: focusing a `blocked` agent consumes nothing, so this one can sit at the head
untouched for a whole cycle.

**Tier**:
One rank of the priority order. The tiers differ mechanically, not just in urgency. Focusing a
`blocked` agent changes nothing. A `working` agent is not waiting on the user at all. Focusing a
`done` agent consumes it on herdr (see **Derived done**), but not on Rex, where the visited set has to
cover it. Ranks of the *raise ladder* are **rungs**, never tiers.

**Press**:
One activation of the button. Its contract is *"put the cursor in the most urgent agent"*: focus that
agent's unit, then raise the window that shows it. What a press must deliver is that the agent is
**typeable**, not merely visible ([#15](https://github.com/sigma/sd-herdr/issues/15)); "show me the
tab holding the most urgent agent" was the earlier reading, and it is the visibility framing that
made tab-granular stepping look correct. Still never "advance to the next agent": on herdr, a press
can consume several `done` agents at once (see **Tab-scoped consumption**).

**Visited set**:
The record, per agent unit, of which attention agents this cycle has already shown. It is *pruned* to
agents still in the attention set — never reset on membership change — and cleared on wrap, on
`willDisappear` of the last tile on the session, and on a detected server restart. It records every
target whatever its tier, and it is what moves the cycle past the agents a press does not consume:
`blocked` and `working` on both backends, and `done` on Rex.
_Avoid_: seen (that is herdr's flag, with different scope and a different owner), read, ring cursor.

**Stepping**:
How selection advances press to press: per agent unit, over the visited set
([#15](https://github.com/sigma/sd-herdr/issues/15)). Focus lands on one unit, so two agents placed
in one tab need two presses — that second press is not waste, it is the only way to get the cursor
into the second agent.
_Avoid_: tab-granular stepping, ranked tabs, exhausted tab — all deleted with the visibility framing
that justified them.

**Wrap**:
The point at which every attention agent is visited, clearing the visited set so the next press
returns to the top of the priority order.

**Next press target**:
The highest-priority agent not in the visited set — where the button will actually take the user.
Equal to the top-priority agent at the start of a cycle, and divergent from it thereafter. **This is
what the tile's body names** ([#12](https://github.com/sigma/sd-herdr/issues/12)): the body follows the
button, the state colour keeps urgency. Naming the top-priority agent instead leaves the tile inert
for an entire cycle of `blocked` agents, since none of them are consumed by being shown. It is drawn
as the target's group label, plus a **position index** when the target has an **attention sibling**
([#16](https://github.com/sigma/sd-herdr/issues/16)).

**Attention sibling**:
Another attention agent in the target's tab. Its presence is what makes a group label ambiguous, and
is therefore the *only* trigger for the position index — the face pays for disambiguation exactly
where it is needed and nowhere else. Not merely another unit in the tab: a plain shell alongside the
target leaves the label unambiguous, because the press can still only go to the one agent.

**Position index**:
The target's 1-based position among **every** unit in its tab's layout, agent or not, in geometric
order. It counts units rather than agents so that the number names what is on screen, which is the
only thing the user can check it against. It is never derived from an id. A target the layout does
not hold gets no index, and the body is its bare group label.
_Avoid_: agent index, an id's suffix. Each backend's section names the unit it counts (herdr's pane
index, Rex's tiled blocks).

**Poll loop**:
One session key's snapshot loop, **shared by every tile pointed at it**. A herdr snapshot costs ~110
ms and ~15 KB, so two tiles on one session must cost one poll rather than two. They share the *cycle*
as well, which is the honest reading of a visited set that belongs to a session: two tiles on one
session are two views of one walk through it. What stays per-tile is the **raise**, since it ends at a
particular key with that key's own settings and its own alert — each press is remembered until its
raise comes back. The one exception is a tile that goes away mid-press: its raise is handed to a tile
that is still there rather than dropped, because the press still asked to be taken to the session.

**Raise**:
The second half of a press: bringing the window that shows the session to the front, after the focus
has moved the backend's own cursor. The raise moves the window; the focus moves the cursor, and the
two are distinct.

**Face**:
What the tile renders for the current attention set: a state colour (red = any `blocked`, green =
`done` and nothing blocked, amber = `working` and nothing more urgent, dark = every agent `idle` or none at all, grey =
cannot see the session), a session nameplate, a label for the *next press target*, and tier-coloured
dots for the other waiters. The colours read as a traffic light — red stopped, amber running, green
arrived — so green is the finished tier and amber the one still in flight. The label is the target's
group, plus a *position index* when an attention sibling shares its tab
([#16](https://github.com/sigma/sd-herdr/issues/16)). The three speak different axes and are allowed
to disagree — colour is the whole session, the label is where the next press goes, the dots are
everyone else still waiting. In particular a red bar over a green-tier label is correct, not a bug
([#12](https://github.com/sigma/sd-herdr/issues/12)).

**Pips**:
The tier-coloured dots for the **other** waiters — everyone in the attention set the body does not
name, in priority order. The named agent never gets a dot, so body and pips never restate each other.
The row draws at most **four** and then says `…` rather than counting: past four, "several more are
waiting" is the whole of what a 72px tile can carry, and an exact count is not something a user acts
on differently. The hollow-vs-filled axis stays deliberately unused (see **Tab-scoped consumption**).
An `unknown` pip is drawn in the grey face's body ink, not the grey plate's fill: a small dot the
colour of the grey plate vanishes against the tile's ground, which would count a waiter the face does
not show.

**Nameplate**:
The state-coloured bar across the top of the tile, carrying the session's name. It **clips with an
ellipsis** rather than shrinking to fit — a name shrunk to ~5px is unreadable, and so fails the tile's
only job, while a legible prefix is enough to tell two sessions apart. The text is the backend's
`plateFor` (herdr: the configured session name, or `herdr` for `default`; Rex: `rex`, since the tile
speaks for the whole server). A grey tile always
reads the backend's name (`herdr` or `rex`), whatever the session is called: it cannot verify the
name, and the state colour, not the text, is what keeps grey apart. **Every** grey reads the same, including
the `unknown`-only set, whose name a snapshot did in fact verify: grey is deliberately one state, and a
plate that varied by cause would split on the face what the colour joins.

**Grey**:
The single "cannot see anything" state — no reachable server or session, a stale snapshot past the 3 s
deadline, an attention set of *only* `unknown` agents, and the settling window. Deliberately *one*
state, and never to be rendered as "all clear". `unknown` is not a colour of its own: "there are agents
and I cannot tell what they are doing" is the same thing to a user as "I cannot see the session".
_Avoid_: disconnected, offline, error (these imply a distinction the face does not make).

**Staleness deadline**:
The age — **3 s** — at which the last good snapshot stops being trusted and the face goes grey. A
*deadline on the age of the data*, never a count of failures: a counter cannot notice a poll that
wedged without ever returning, and would leave a confident face on the key forever. It is measured by
a **heartbeat**, a timer that carries the current time into the core and asks the backend for nothing,
so the deadline can pass while nothing else is happening. Decoupled from **Settling**, which answers a
different question.
_Avoid_: timeout, failure count.

**Backoff**:
How long the plugin waits before retrying a snapshot that failed — the poll cadence, doubling per
consecutive failure to a **5 s ceiling**, reset by the first good snapshot. The one thing in the plugin
that *is* keyed on a failure count, and it is a separate question from the **staleness deadline**:
backoff decides how often to ask, the deadline decides when to stop believing the last answer. A
failure count may set the retry gap; it may never set the face.

**Settling**:
The grey hold after a *server lifetime* boundary, before the face is trusted again. Its length is the
backend's `settleMs`: **4 s** on herdr, where the snapshot can say dark while the data is untrustworthy
for ~3.7 s, and **none** on Rex, where a restart leaves nothing to wait for. It is the one place the
plugin deliberately overrides its own data. herdr's value is sized for its live handoff's measured worst
case ([#13](https://github.com/sigma/sd-herdr/issues/13)), because the handoff and the stop/restart look
the same when they happen. **Decoupled** from the staleness deadline, which answers a
different question. Ends on a fixed timer — after a restart a dark face is honest, since a server whose
agent processes are dead genuinely has none.
_Avoid_: reconnecting, recovering (both imply the agents are on their way back — true only of a
handoff, and only for `blocked` agents).

## herdr

The terms below belong to herdr. Its agents are panes, its groups are workspaces, and its tabs are
tabs.

**Agent detection**:
How herdr decides a pane hosts an agent: by detection, or by `pane.report_agent`. Only panes carrying
an `agent` field are agents; the rest are plain shells.

**Seen**:
herdr's per-pane flag meaning "the user has had this pane on screen since it last changed". Focusing a
tab clears it for **every** pane in that tab, because a tab's panes are tiled and visible together.
_Avoid_: read, acknowledged, dismissed.

**Derived done**:
herdr does not report `done` as a state. It derives `done` from `(idle, seen = false)`, so a herdr
agent can only be `done` in the outbound direction, and focusing one turns it `idle`. That is why the
`done` tier is self-consuming on herdr ([#6](https://github.com/sigma/sd-herdr/issues/6)), and why only
`blocked` needs the visited set there.

**Live handoff**:
A lifetime boundary that keeps the agents: herdr hands its panes to a new server without killing them.
Its boundary is observable, since every pane's `terminal_id` is regenerated while its `pane_id` stays
put. A stop/restart is the other shape. It kills the agents, and the two cannot be told apart at the
moment they happen ([#13](https://github.com/sigma/sd-herdr/issues/13)). So one policy has to cover
both, sized for the handoff.

**Re-detection**:
How an agent returns after a live handoff — herdr identifies it from the pane's foreground process on a
fixed tick, **never from pane output**, so a silent agent returns as fast as a noisy one. It comes back
with a *seeded* `Idle` state, held for a 3 s startup grace window before the screen is read, which is
why agents reappear at ~0.4 s but correct statuses only at ~3.7 s. The seed reports `idle` and never
`done`, so the tile can only under-report during the window, never flash a false red or green. One
casualty: a `done` agent returns as plain `idle` and stays there — the `seen` flag is gone and nothing on
screen recovers it.

**Tab-scoped consumption**:
The reason `tabId` survives in the model despite pane-granular stepping: focusing any pane calls
herdr's `mark_active_tab_seen()`, clearing `seen` on **every** pane in that tab. So one press consumes
every `done` agent in the target's tab. Its accepted consequence — **a second `done` agent in a tab is
unreachable by button**, since focusing its neighbour consumes it first. `blocked` is unaffected, being
a reported state rather than `idle + !seen`. The face gives **no warning** before it happens
([#16](https://github.com/sigma/sd-herdr/issues/16)): the cost is one the user cannot avoid, so drawing
it would spend the pip row's last free axis to no end. The pips' hollow-vs-filled axis stays
deliberately unused. This does not apply on Rex, where focus changes no status.

**Pane index**:
herdr's **position index**: the target's 1-based position among **every** pane in its tab, agent or
shell, in geometric order — the snapshot's `layouts[]` entry sorted by `(rect.y, rect.x)`. An
`agent | shell | agent` tab reads ① and ③. Never derived from the `pane_id`, whose suffixes are neither
contiguous nor ordered.
_Avoid_: agent index, pane number (that is the id's suffix, an unrelated counter).

**sessionName**:
The per-button setting naming the herdr session a tile speaks for, defaulting to `default`. It is
resolved to a socket path by herdr's on-disk *convention* rather than by `herdr session list`
([#20](https://github.com/sigma/sd-herdr/issues/20)): the listing needs the `herdr` binary, which is not
on a plugin's PATH, and "is it running" is better answered by connecting. The socket path is the
session key. Changing the name repoints the button, which re-resolves the socket and starts the cycle
over.

**Nonce**:
The human-legible marker the plugin writes into herdr's `client_window_title` to identify the host
terminal window for raising. Human-legible rather than a hex blob because a client dying mid-press
strands it in the title bar permanently. Written as `sd-mux raise <session> #<n>`: it names the tool
that wrote it and the session it was raising, and the counter tells one press's marker from an
earlier one's. It is *not* a uniqueness device — a session has one `client_window_title`, so two tiles
watching the same session collide there regardless.

**Raise ladder**:
The ordered mechanisms tried until one of them raises, each a **rung**: the window-manager adapter, the
AppleScript adapter table, app activation, then declining. Ordered window-manager-first because that
rung needs no Automation grant, not because it is more accurate.
_Avoid_: tier (that is a rank of the priority order, an unrelated axis), fallback chain.

**Exact raise**:
A raise that targets the one window carrying the nonce. The first two rungs are exact; app activation
is not — it raises *an* application window, which under a tiling window manager is the one already on
screen, and so is wrong rather than merely imprecise.

**Decline**:
Refusing to raise at all, rather than reaching for a rung known to be wrong here. Not a failure: the
press's focus has already happened, so the session did move — only the window did not follow.

**Host-app discovery**:
Naming the terminal *application* that hosts the session, which rung 2 must do before it can script
anything: correlate herdr's client socket in `lsof` to the connected client process, walk its `ppid`
chain to the ancestor `launchd` started, and ask `System Events` for that pid's bundle id. **Rung-2-only
machinery, off the hot path** — a machine with a window manager never reaches it, and so never sends an
Apple Event at all. Its failure cases are real rather than defensive: a client inside tmux or zellij
terminates at a daemonised multiplexer, which is not a GUI application.
_Avoid_: peer pid (both herdr sockets are listened on by the *server*, so asking for our own connection's
peer returns the daemon).

**`hostAppBundleId`**:
The per-button setting naming the application to raise when host-app discovery cannot. Defaults to
`com.mitchellh.ghostty` ([#27](https://github.com/sigma/sd-herdr/issues/27)), which is safe only because
its use is **surfaced**: every press that leans on it flashes the key and logs the rung, since a silent
permanent fallback is how a broken walk goes unnoticed for months. The default is what makes that alert
load-bearing rather than decorative — on a machine running some other terminal, rung 3 will `open` the
configured app, so a wrong value **launches an application the user does not run**. The alert is the only
thing standing between that and a mystery.

**Window-manager adapter**:
The rung that asks the user's tiling window manager to raise a window by id. Generic and app-agnostic —
the only path that reaches a terminal that answers no window queries at all — and the only one the
plugin can take without an Automation grant of its own.

## Rex

The terms below belong to Rex. Its agents are terminal blocks, its groups and tabs are windows, and
its status comes from program status records the program reports.

**Block**:
The unit a Rex window holds, and the unit a press focuses. Only terminal blocks (creator
`com.superlogical.terminal`) carry a program status, so only they can be agents; a block none of whose
records has an `effective_app` is a shell, and never attention. Detached blocks are absent from the
view, so they are never attention either.
_Avoid_: pane, tab, window (a window is the tab and the group together).

**Window**:
A Rex window: the tab and the group at once, so the snapshot gives it one id for both. Its blocks sit
in layers. The **tiled** layer is the window's own layout, and the position index counts its blocks.
A **floating** layer lies over the window: its agents are still attention, but take no position index.
_Avoid_: pane (herdr's word for the unit a press focuses), workspace.

**Default window label**:
The label Rex gives a window nobody named: `Window ` followed by the last eight characters of its
`window_id`. The body compares a window's label against that computed string, rather than matching a
pattern. A window carrying exactly the default string, or no label, is treated as unnamed, and the body
then uses the title of an agent in it: the focused block's, if it is a titled agent, then the first
titled agent in document order. A window with no titled agent keeps its default label, which at least
is stable, or, with no label at all, its id.

**Program status record**:
One entry of a terminal block's `program_status`: `state`; `updated_at`, the server's clock in RFC 3339;
an optional `id`, absent on the root record and a slash nests children; `app` and `effective_app`, where a
child may carry only the latter, inherited from its nearest ancestor. A block's status is the most urgent
of its records (the longest-waiting among equals), and its wait key is that record's `updated_at`.
`error` reads as `blocked`, and a state the plugin does not know reads as `idle`, so Rex never produces
`unknown` and the `unknown`-only grey never arises on it.
_Avoid_: status (on its own, it names the core's agent status).

**Done held by Rex**:
Rex does not clear `done` on its own. Focusing the block, pressing keys into it, and showing the session
change nothing; the record leaves `done` only when the program reports its next state, which Claude Code
does when its next turn starts ([program status](docs/research/rex-program-status.md) §1). The plugin
cannot clear it either: the terminal's methods do not write program status. So on Rex a press does not
consume `done`, and the visited set has to cover that tier.

**`instance_id`**:
The Rex server's lifetime marker, `server.status.instance_id`. It is new on every start, and the plugin
reads it on each connection rather than on each poll, because a restart always drops the connection
first. Rex sends one witness for the whole server, so one key covers it.

**Rex restart**:
A server restart kills every terminal process and drops every program status record. The session, window
and block ids survive, but nothing comes back. So no settling is needed, and a dark tile afterwards is
the truth. herdr's live handoff has no Rex counterpart ([restart](docs/research/rex-server-restart.md)).

**App client**:
The Rex app as a client of the server: the connected client of kind `app` on the local unix socket. It
is the only client a press can use to show a session. A paired phone or another Mac is an app client
too; requiring the unix transport is meant to pass it over, but no such client has been tested.

**Control connection**:
The one long-lived `rex.control.v1` WebSocket the plugin holds to the Rex server, shared by every Rex
tile. It opens on the first request while something holds it (a Rex tile on the deck), and closes
with a close frame when the last holder lets go, so the server holds no ghost client. A request with
no holder is refused rather than reopening it. The plugin polls it; it does not apply the server's
pushed events.

**Rex session**:
One of the server's sessions, identified by its `session_id`, which the API documents never changes,
is never reused, and survives a server restart. A tile does not pick one: each poll lists them all
and merges their windows, and a press finds the session holding the agent's block before focusing
it. Every id carries a UUID (`session:…`, `window:…`, `block:…`), so merging needs no renaming.
_Avoid_: session, unqualified (the neutral **Session** is the whole server here).

**Displayed session**:
The session the Rex app is showing. The API reports none, and no field, event or action tracks it, so
the plugin cannot follow it. It does not need to: a tile watches every session, and a press tells the
app which session and window to show.
_Avoid_: current session, active session (the server's active window is not the window the app shows).
