# sd-herdr

A Stream Deck button that surfaces whether any agent in a [herdr](https://github.com/ogulcancelik/herdr)
session needs attention, and on press takes the user to the most urgent one. This
glossary is the vocabulary the design decisions on
[map #1](https://github.com/sigma/sd-herdr/issues/1) are argued in.

## herdr's world

**Agent**:
A pane that herdr has identified as hosting a coding agent, either by detection or via
`pane.report_agent`. Only panes carrying an `agent` field are agents; the rest are
plain shells.

**Agent status**:
One of `idle | working | blocked | done | unknown`, as herdr *reports* it. Note that
`done` is not a state an agent can be in — herdr derives it from `(idle, seen = false)`
— so it is reportable only in the outbound direction.

**Seen**:
herdr's per-pane flag meaning "the user has had this pane on screen since it last
changed". Focusing a tab clears it for **every** pane in that tab, because a tab's
panes are tiled and visible together.
_Avoid_: read, acknowledged, dismissed.

**Server lifetime**:
One run of a herdr server for a session. Topology — workspaces, tabs, panes, focus —
survives across lifetimes; **agent identity does not**, and herdr never *restores* it.
A lifetime ends at a restart *or* a live handoff, and the two are indistinguishable to a
client **at the moment they happen** — but they do not resolve alike
([#13](https://github.com/sigma/sd-herdr/issues/13)): a restart kills the agent processes
outright, so nothing comes back, while a handoff leaves them running and herdr
re-**detects** them within ~0.4 s. Since a client cannot tell which it is looking at, one
policy has to cover both, sized for the handoff. Its boundary is observable: every pane's
`terminal_id` is regenerated while its `pane_id` stays put.

**Re-detection**:
How an agent returns after a handoff — herdr identifies it from the pane's foreground
process on a fixed tick, **never from pane output**, so a silent agent returns as fast as
a noisy one. It comes back with a *seeded* `Idle` state, held for a 3 s startup grace
window before the screen is read, which is why agents reappear at ~0.4 s but correct
statuses only at ~3.7 s. The seed reports `idle` and never `done`, so the tile can only
under-report during the window, never flash a false red or green. One casualty: a `done`
agent returns as plain `idle` and stays there — the `seen` flag is gone and nothing on
screen recovers it.

**Tab**:
herdr's unit of visibility — a set of tiled panes, exactly one of which is focused, and
exactly one tab of one workspace visible at a time. The tab, not the pane, is what a
press reveals.

## The attention model

**Attention set**:
The agents the button is speaking for: `blocked` ∪ `done` ∪ `working` ∪ (`unknown` with
an `agent` field). `idle` is the only status left out — it means "already looked at, no
follow-up", so there is nothing to walk to. A `working` agent is owed no answer, but it
is somewhere to *check on*, and the cycle reaches it once everything more urgent is
spent.
_Avoid_: queue, backlog, alerts, notifications.

**Priority order**:
The total order over the attention set: tier `blocked` → `done` → `working` →
`unknown`, then lowest `state_change_seq` first within a tier, so the longest-waiting
agent wins.

**Top-priority agent**:
The head of the attention set under priority order, ignoring the visited set. Stable —
and *not* what the tile names ([#12](https://github.com/sigma/sd-herdr/issues/12)). It
survives only as the thing the state colour speaks for: focusing a `blocked` agent
consumes nothing, so this one can sit at the head untouched for a whole cycle.

**Tier**:
One rank of the priority order. The tiers differ mechanically, not just in urgency:
focusing a `done` agent consumes it, focusing a `blocked` agent changes nothing, and a
`working` agent is not waiting on the user at all. Ranks of the *raise ladder* are
**rungs**, never tiers.

## The button

**`sessionName`**:
The per-button setting naming the herdr session a tile speaks for, defaulting to
`default`. **One tile speaks for exactly one session** — that is what keeps the face's
single colour meaningful — so watching two sessions means two buttons. Resolved to a
socket path by herdr's on-disk *convention* rather than by `herdr session list`
([#20](https://github.com/sigma/sd-herdr/issues/20)): the listing needs the `herdr`
binary, which is not on a plugin's PATH, and "is it running" is better answered by
connecting. Changing it repoints the button, which re-resolves the socket and starts the
cycle over.

**Poll loop**:
One socket path's snapshot loop, **shared by every button pointed at it**. A snapshot is
~110 ms and ~15 KB, so two tiles on one session must cost one poll rather than two. They
share the *cycle* as well, which is the honest reading of a visited set that belongs to a
session: two tiles on one session are two views of one walk through it. What stays
per-button is the **raise**, since it ends at a particular key with that key's own
`hostAppBundleId` and its own alert — each press is remembered until its raise comes
back. The one exception is a button that goes away mid-press: its raise is handed to a
button that is still there rather than dropped, because the nonce is already in the
window title and the user still asked to be taken to the session.

## The cycle

**Press**:
One activation of the button. Its contract is *"put the cursor in the most urgent agent"*
— focus that pane, then raise the host terminal window. What a press must deliver is that
the agent is **typeable**, not merely visible
([#15](https://github.com/sigma/sd-herdr/issues/15)); "show me the tab holding the most
urgent agent" was the earlier reading, and it is the visibility framing that made
tab-granular stepping look correct. Still never "advance to the next agent": a press can
consume several `done` agents at once, because focus clears herdr's `seen` for the whole
tab.

**Visited set**:
The **pane**-keyed record of which attention panes this cycle has already shown. It is
*pruned* to panes still in the attention set — never reset on membership change — and
cleared on wrap, on `willDisappear`, and on a detected server restart.
_Avoid_: seen (that is herdr's flag, with different scope and a different owner), read,
ring cursor.

**Stepping**:
How selection advances press to press: **pane-granular**, over the pane-keyed visited set
([#15](https://github.com/sigma/sd-herdr/issues/15)). Focus lands on one pane, so two
agents tiled in one tab need two presses — that second press is not waste, it is the only
way to get the cursor into the second agent.
_Avoid_: tab-granular stepping, ranked tabs, exhausted tab — all deleted with the
visibility framing that justified them.

**Tab-scoped consumption**:
The reason `tabId` survives in the model despite pane-granular stepping: focusing any
pane calls herdr's `mark_active_tab_seen()`, clearing `seen` on **every** pane in that
tab. So one press consumes every `done` agent in the target's tab. Its accepted
consequence — **a second `done` agent in a tab is unreachable by button**, since focusing
its neighbour consumes it first. `blocked` is unaffected, being a reported state rather
than `idle + !seen`. The face gives **no warning** before it happens
([#16](https://github.com/sigma/sd-herdr/issues/16)): the cost is one the user cannot
avoid, so drawing it would spend the pip row's last free axis to no end. The pips'
hollow-vs-filled axis stays deliberately unused.

**Wrap**:
The point at which every attention pane is visited, clearing the visited set so the next
press returns to the top of the priority order.

**Next press target**:
The highest-priority pane not in the visited set — where the button will actually take
the user. Equal to the top-priority agent at the start of a cycle, and divergent from it
thereafter. **This is what the tile's body names**
([#12](https://github.com/sigma/sd-herdr/issues/12)): the body follows the button, the
state colour keeps urgency. Naming the top-priority agent instead leaves the tile inert
for an entire cycle of `blocked` agents, since none of them are consumed by being shown.
It is drawn as the target's workspace label, plus a **pane index** when the target has an
**attention sibling** ([#16](https://github.com/sigma/sd-herdr/issues/16)).

**Attention sibling**:
Another attention pane sharing the target's tab. Its presence is what makes a workspace
label ambiguous, and is therefore the *only* trigger for the pane index — the face pays
for disambiguation exactly where it is needed and nowhere else. Not merely another pane
in the tab: a plain shell alongside the target leaves the label unambiguous, because the
press can still only go to the one agent.

**Pane index**:
The target's 1-based position among **every** pane in its tab, agent or shell, in
geometric order — the snapshot's `layouts[]` entry sorted by `(rect.y, rect.x)`. It
counts panes rather than agents so that the number names what is on screen, which is the
only thing the user can check it against: an `agent | shell | agent` tab reads ① and ③.
Never derived from the `pane_id`, whose suffixes are neither contiguous nor ordered.
_Avoid_: agent index, pane number (that is the id's suffix, an unrelated counter).

## The raise

**Raise**:
The second half of a press: bringing the terminal window that hosts the herdr client to
the front, on the workspace the user is actually looking at. Distinct from the *focus*
that precedes it — focus moves herdr's own cursor, the raise moves macOS's.

**Raise ladder**:
The ordered mechanisms tried until one of them raises, each a **rung**: the
window-manager adapter, the AppleScript adapter table, app activation, then declining.
Ordered window-manager-first because that rung needs no Automation grant, not because it
is more accurate.
_Avoid_: tier (that is a rank of the priority order, an unrelated axis), fallback chain.

**Exact raise**:
A raise that targets the one window carrying the nonce. The first two rungs are exact;
app activation is not — it raises *an* application window, which under a tiling window
manager is the one already on screen, and so is wrong rather than merely imprecise.

**Decline**:
Refusing to raise at all, rather than reaching for a rung known to be wrong here. Not a
failure: the press's focus has already happened, so the session did move — only the
window did not follow.

**Host-app discovery**:
Naming the terminal *application* that hosts the session, which rung 2 must do before
it can script anything: correlate herdr's client socket in `lsof` to the connected
client process, walk its `ppid` chain to the ancestor `launchd` started, and ask
`System Events` for that pid's bundle id. **Rung-2-only machinery, off the hot path** —
a machine with a window manager never reaches it, and so never sends an Apple Event at
all. Its failure cases are real rather than defensive: a client inside tmux or zellij
terminates at a daemonised multiplexer, which is not a GUI application.
_Avoid_: peer pid (both herdr sockets are listened on by the *server*, so asking for
our own connection's peer returns the daemon).

**`hostAppBundleId`**:
The per-button setting naming the application to raise when host-app discovery cannot.
Defaults to `com.mitchellh.ghostty` ([#27](https://github.com/sigma/sd-herdr/issues/27)),
which is safe only because its use is **surfaced**: every press that leans on it flashes
the key and logs the rung, since a silent permanent fallback is how a broken walk goes
unnoticed for months. The default is what makes that alert load-bearing rather than
decorative — on a machine running some other terminal, rung 3 will `open` the configured
app, so a wrong value **launches an application the user does not run**. The alert is the
only thing standing between that and a mystery.

**Window-manager adapter**:
The rung that asks the user's tiling window manager to raise a window by id. Generic and
app-agnostic — the only path that reaches a terminal that answers no window queries at
all — and the only one the plugin can take without an Automation grant of its own.

## The face

**Face**:
What the tile renders for the current attention set: a state colour (red = any
`blocked`, green = `done` and nothing blocked, amber = `working` only, dark = every agent
`idle` or none at all, grey = cannot see the session), a session
nameplate, a label for the *next press target*, and tier-coloured dots for the
other waiters. The colours read as a traffic light — red stopped, amber running, green
arrived — so green is the finished tier and amber the one still in flight. The label is
the target's workspace, plus a *pane index* when an attention
sibling shares its tab ([#16](https://github.com/sigma/sd-herdr/issues/16)). The three
speak different axes and are allowed to disagree — colour is
the whole session, the label is where the next press goes, the dots are everyone else
still waiting. In particular a red bar over a green-tier label is correct, not a bug
([#12](https://github.com/sigma/sd-herdr/issues/12)).

**Pips**:
The tier-coloured dots for the **other** waiters — everyone in the attention set the
body does not name, in priority order. The named agent never gets a dot, so body and
pips never restate each other. The row draws at most **four** and then says `…` rather
than counting: past four, "several more are waiting" is the whole of what a 72px tile
can carry, and an exact count is not something a user acts on differently. The
hollow-vs-filled axis stays deliberately unused (see **Tab-scoped consumption**). An
`unknown` pip is drawn in the plate's grey *ink*, not its fill: a 4px dot the colour of
the grey plate vanishes against the tile's ground, which would count a waiter the face
does not show.

**Nameplate**:
The state-coloured bar across the top of the tile, carrying the session name. It **clips
with an ellipsis** rather than shrinking to fit — a name shrunk to ~5px is unreadable, and
so fails the tile's only job, while a legible prefix is enough to tell two sessions apart.
A session named `default` renders **`herdr`**: `default` is herdr's placeholder rather
than a name the user chose, so the slot buys product identity instead. Grey falls back to
`herdr` for a different reason — it cannot verify the name — and the state colour, not the
text, is what keeps the two apart ([#16](https://github.com/sigma/sd-herdr/issues/16)).
**Every** grey reads `herdr`, including the `unknown`-only set, whose name a snapshot did
in fact verify: grey is deliberately one state, and a plate that varied by cause would
split on the face what the colour joins.

**Grey**:
The single "cannot see anything" state — unreachable socket, stopped session, stale
snapshot past the 3 s deadline, an attention set of *only* `unknown` agents, and the
settling window. Deliberately *one* state, and never to be rendered as "all clear".
`unknown` is not a colour of its own: "there are agents and I cannot tell what they are
doing" is the same thing to a user as "I cannot see the session".
_Avoid_: disconnected, offline, error (these imply a distinction the face does not
make).

**Staleness deadline**:
The age — **3 s** — at which the last good snapshot stops being trusted and the face goes
grey. A *deadline on the age of the data*, never a count of failures: a counter cannot
notice a poll that wedged without ever returning, and would leave a confident face on the
key forever. It is measured by a **heartbeat**, a timer that carries the current time into
the core and asks herdr for nothing, so the deadline can pass while nothing else is
happening. Decoupled from **settling**, which answers a different question.
_Avoid_: timeout, failure count.

**Backoff**:
How long the plugin waits before retrying a snapshot that failed — the poll cadence,
doubling per consecutive failure to a **5 s ceiling**, reset by the first good snapshot.
The one thing in the plugin that *is* keyed on a failure count, and it is a separate
question from the **staleness deadline**: backoff decides how often to ask,
the deadline decides when to stop believing the last answer. A failure count may set the
retry gap; it may never set the face.

**Settling**:
The grey hold after a *server lifetime* boundary, before the face is trusted again — a
**fixed 4 s** on a `terminal_id` change, and the one place the plugin deliberately
overrides its own data: the snapshot says dark, but the plugin knows the data is
untrustworthy for ~3.7 s. Sized for the handoff's measured worst case
([#13](https://github.com/sigma/sd-herdr/issues/13)) because the two boundary shapes are
indistinguishable when they happen. **Decoupled** from the staleness deadline, which
answers a different question. Ends on a fixed timer — after a restart a dark face is
honest, since a herdr whose agent processes are dead genuinely has none.
_Avoid_: reconnecting, recovering (both imply the agents are on their way back — true
only of a handoff, and only for `blocked` agents).

**Nonce**:
The human-legible marker the plugin writes into herdr's `client_window_title` to
identify the host terminal window for raising. Human-legible rather than a hex blob
because a client dying mid-press strands it in the title bar permanently. Written as
`sd-mux raise <session> #<n>`: it names the tool that wrote it and the session it was
raising, and the counter tells one press's marker from an earlier one's. It is *not* a
uniqueness device — a session has one `client_window_title`, so two tiles watching the
same session collide there regardless.
