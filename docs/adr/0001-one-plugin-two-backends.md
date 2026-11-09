# 1. One plugin with a backend seam, not a sibling copy

- **Status:** accepted
- **Date:** 2026-11-06
- **Decided on:** [map #29](https://github.com/sigma/sd-mux/issues/29)
- **Specified in:** [spec #35](https://github.com/sigma/sd-mux/issues/35)

## Context

The plugin watched only herdr. Rex, a second terminal multiplexer with its own API, needs the same
kind of button: a poll of the session, an attention model over its agents, a face on the key, and a
press that walks the user to the agent. Both need the same policy. Each tile speaks for one session, a
press focuses an agent and raises its window, and a grey tile says it cannot see the session.

The two backends differ in a few known places: what a snapshot is and how it is
fetched, how a press reaches the window, whether focusing an agent clears its `done` state, whether a
restart needs a grey hold, and how a restart is detected. The research for each is in `docs/research/`.
The map worked those differences through, and the spec carries its decisions into work items.

## Decision

One Stream Deck plugin serves both backends. It is renamed `sd-mux`, which gives it a new plugin UUID
(`dev.yrh.sd-mux`): keys already placed must be dragged on again, a cost the map accepted.

The core stays one. The attention model, the visited set, the face and the grey rule are written once,
against a neutral snapshot. Each backend supplies:

- a pure conversion from its own wire format to that snapshot;
- a client and a press, which are the edge;
- a `Backend` record: the name it paints on grey, whether a press writes a window marker, how long a
  restart holds grey, and the plate for a session.

There is one Stream Deck action, and a tile's backend is a setting beside its session; the **Terminal
app** setting is herdr-only. The differences live behind that seam, not in a fork of the plugin.

**Amended:** a Rex tile speaks for the whole local Rex server, every session in it, not for one Rex
session. The core's "session" is the unit a tile watches, and on Rex that unit is the server. The
core lost `Snapshot.label`, which existed only to put a Rex session's label on the plate, and
nothing else in it changed. A Rex tile has no session setting, and its plate is `rex`.

## Alternatives considered

- **A sibling plugin, copied from sd-herdr and adapted for Rex.** Rejected. The copy would duplicate
  the core, which is the whole design and the part with the tests, and a copied core drifts: the
  difference would be a bug that nobody chose. The policy the user notices is meant to be the same on
  both backends: the colours, the walk through the attention set, and the grey rule.

The map records the other decisions taken with this one. One bears on the seam: the press keeps the
plugin's own cycle on both backends rather than using Rex's own `agent_jump` action, because that
action's order is not guaranteed to match the body and the pips. See
[map #29](https://github.com/sigma/sd-mux/issues/29).

## Reasons

- The seam was nearly there. The core touched herdr through two imports only, the `Snapshot` type and
  `DEFAULT_SESSION`, and all herdr I/O was wired in `src/actions/attention-action.ts`, so a backend
  seam cost less than a copy ([map #29](https://github.com/sigma/sd-mux/issues/29), [spec #35](https://github.com/sigma/sd-mux/issues/35)).
- One pure core keeps every policy decision in one tested place, and each backend's conversion into
  it is a pure function tested on its own fixtures, so a protocol change shows up as a failing
  conversion test rather than as drift in the policy ([spec #35](https://github.com/sigma/sd-mux/issues/35), user stories 15 and 16).
- One habit works whichever multiplexer an agent runs in, and a herdr tile and a Rex tile can sit side
  by side, each speaking for one session ([spec #35](https://github.com/sigma/sd-mux/issues/35), user stories 1 and 2).

## Consequences

- A change to the policy changes both backends. That is the point, and the fixtures on each side are
  what would show a regression on one.
- The neutral snapshot has to stay small. A new backend has to fit its state into the snapshot, the
  `Backend` record and the lifetime marker. A backend that does not fit is a new decision, not a new
  branch in the core.
- The docs keep the two backends apart. `CONTEXT.md` has a neutral layer and one section per backend,
  and the README gives each backend its own setup, press and manual checks.
- Out of scope, per the spec: a third backend, remote Rex hosts, and pushed Rex events. The 1 s poll
  stays.

## Links

- Map: [#29](https://github.com/sigma/sd-mux/issues/29)
- Spec: [#35](https://github.com/sigma/sd-mux/issues/35)
- Vocabulary: [`CONTEXT.md`](../../CONTEXT.md)
- Research: [`rex-control-api.md`](../research/rex-control-api.md),
  [`rex-program-status.md`](../research/rex-program-status.md),
  [`rex-raise.md`](../research/rex-raise.md),
  [`rex-server-restart.md`](../research/rex-server-restart.md),
  [`rex-displayed-session.md`](../research/rex-displayed-session.md)
