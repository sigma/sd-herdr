# The fixture corpus

Every test in this repo that needs a herdr snapshot reads one of these files. There are
no snapshot literals inlined in test bodies: a fixture that lives in one place can be
described once, and a reviewer can check what a test is asserting against without
reading the test.

## Provenance is part of the fixture, not a sidecar

Each file is `{ "provenance": {...}, "snapshot": {...} }`. The provenance block travels
with the data because the two kinds of fixture here carry very different authority:

- **`"kind": "captured"`** — bytes that came off a real herdr socket. This is *evidence
  about one installation at one moment*: it proves a shape exists, and proves nothing
  about shapes it happens not to contain. It carries `capturedAt`, the `subject`
  (herdr version, protocol, OS) and the `method` used.
- **`"kind": "derived"`** — hand-written. It says so, in those words, and names what it
  was modelled on in `derivedFrom`. A derived fixture is a *statement of intent*: it
  encodes what we believe the shape means, so a test passing against it says the code
  matches our reading of the spec, not that it matches herdr.

The corpus is mostly derived, and that is forced rather than lazy. The button exists for
`blocked` and `done`, and neither can be captured on demand: a real session goes
`blocked` when a real agent asks a real question, and `done` is not a state at all —
herdr derives it from `(idle, seen = false)`, so it is reportable only outbound. The one
captured fixture holds six `idle` agents and one `working` one, which is what a live
session offers unprompted.

Derived fixtures carry only the fields their scenario exercises, and say so.
`blocked-one.json` is the exception and is kept complete, as the shape reference.

## The files

| File | Kind | What it is for |
|---|---|---|
| `snapshots/live-session.json` | captured | The real wire shape: 8 workspaces, 16 panes, 7 agents, verbatim. |
| `snapshots/blocked-one.json` | derived | One `blocked` beside one `working` — the minimal red case. |
| `snapshots/done-only.json` | derived | Two `done`, nothing blocked — the amber case. |
| `snapshots/mixed-tiers.json` | derived | All tiers, with sequence numbers fighting tier order. |
| `snapshots/unknown-only.json` | derived | Attention made of `unknown`, plus one entry with no `agent` field. |
| `snapshots/no-agents.json` | derived | A live session with no agents — the honest dark face. |
| `snapshots/split-tab.json` | derived | `agent \| shell \| agent` in one tab, listed out of geometric order. |
| `snapshots/done-pair.json` | derived | Two `done` agents tiled in one tab, plus a third alone — the tab-scoped consumption case. |
| `snapshots/done-pair-consumed.json` | derived | `done-pair.json` one poll after a press: the whole tab came back `idle`. |
| `snapshots/done-pair-newcomer.json` | derived | `done-pair.json` plus an agent that arrived mid-cycle, last in priority order. |

## Adding one

Capture where you can, derive where you must, and say which. If you derive a shape
because a live session refused to produce it, put *that* in the note — the reason a
fixture is hand-written is usually the most interesting thing about it.
