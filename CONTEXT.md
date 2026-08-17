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

**Tab**:
herdr's unit of visibility — a set of tiled panes, exactly one of which is focused, and
exactly one tab of one workspace visible at a time. The tab, not the pane, is what a
press reveals.

## The attention model

**Attention set**:
The agents the button is speaking for: `blocked` ∪ `done` ∪ (`unknown` with an `agent`
field). `working` and `idle` are not attention — `idle` means "already looked at, no
follow-up".
_Avoid_: queue, backlog, alerts, notifications.

**Priority order**:
The total order over the attention set: tier `blocked` → `done` → `unknown`, then
lowest `state_change_seq` first within a tier, so the longest-waiting agent wins.

**Top-priority agent**:
The head of the attention set under priority order, ignoring the visited set. Stable,
and what the tile's body names today.

**Tier**:
One rank of the priority order. The `blocked` and `done` tiers differ mechanically, not
just in urgency: focusing a `done` agent consumes it, focusing a `blocked` agent
changes nothing.

## The cycle

**Press**:
One activation of the button. Its contract is *"show me the tab holding the most urgent
agent"* — focus that tab's top-ranked pane, then raise the host terminal window. Never
"advance to the next agent": a press can consume several `done` agents at once.

**Visited set**:
The **pane**-keyed record of which attention panes this cycle has already shown. It is
*pruned* to panes still in the attention set — never reset on membership change — and
cleared on wrap, on `willDisappear`, and on a detected server restart.
_Avoid_: seen (that is herdr's flag, with different scope and a different owner), read,
ring cursor.

**Exhausted tab**:
A tab all of whose attention panes are in the visited set. Selection skips it. A new
agent appearing in such a tab un-exhausts it, which is why the visited set is keyed by
pane while stepping happens in tabs.

**Wrap**:
The point at which every tab is exhausted, clearing the visited set so the next press
returns to the top of the priority order.

**Next press target**:
The top-ranked non-exhausted tab — where the button will actually take the user. Equal
to the top-priority agent's tab at the start of a cycle, and divergent from it
thereafter. The two are distinct concepts precisely because that divergence is visible
to the user ([#12](https://github.com/sigma/sd-herdr/issues/12)).

## The face

**Face**:
What the tile renders for the current attention set: a state colour (red = any
`blocked`, amber = `done` only, dark = clear, grey = cannot see the session), a session
nameplate, the named agent's workspace label, and tier-coloured dots for the other
waiters.

**Grey**:
The single "cannot see anything" state — unreachable socket, stopped session, stale
snapshot past the 3 s deadline. Deliberately *one* state, and never to be rendered as
"all clear".
_Avoid_: disconnected, offline, error (these imply a distinction the face does not
make).

**Nonce**:
The human-legible marker the plugin writes into herdr's `client_window_title` to
identify the host terminal window for raising. Human-legible rather than a hex blob
because a client dying mid-press strands it in the title bar permanently.
