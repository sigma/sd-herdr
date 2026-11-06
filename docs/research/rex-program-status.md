# The lifecycle of a Rex program-status record

Research for [sigma/sd-herdr#31](https://github.com/sigma/sd-herdr/issues/31) (map:
[#29](https://github.com/sigma/sd-herdr/issues/29)).

**Subject**: Rex server `0.0.1793890641-gaf0c20`, API revision 11, fish shell in the scratch
terminal; Claude Code as the agent under observation. Protocol reference: the
[Program Status Protocol (OSC 7501)](https://www.superlogical.com/rex/docs/build/program-status.md).
Transport details are in [rex-control-api.md](rex-control-api.md).

## Evidence key

- **[V]** — verified: a scripted run in a throwaway session (`sdmux-lifecycle`, two
  terminal blocks: *A* reports, *B* is a focus decoy), reading A's records with
  `com.superlogical.terminal.program_status` and recording its `program_status_*` events
  after each step.
- **[O]** — observed: a background listener on the block hosting this Claude Code session,
  during ordinary use.
- **[C]** — a scratch Claude Code (`v2.1.317`) in a throwaway session, given a one-word
  prompt, then focused, shown in the Rex app, and typed at.
- **[P]** — from the protocol specification.

## 1. ⚠️ Nothing on the server clears `done` or `error` except the program

| Step, with A holding a root `done@probe` record | Record after | Event |
| --- | --- | --- |
| `session.focus_block` A (from B) | `done`, unchanged | none |
| `block.event` focus `out` then `in` | `done`, unchanged | none |
| key presses on A (`space`, `backspace`) | `done`, unchanged | none |
| a command runs, new shell prompt | `done`, unchanged | none |
| the same, holding `error` | `error`, unchanged | none |
| the program reports `state=clear` | removed | `program_status_removed {reason: "clear"}` |

**[V]** All of it — and **[C]** the same for a real Claude Code `done`, which is the case
that matters, because Claude Code turns on focus reporting (mode `1004` set) and so *could*
react to being looked at:

| Step, with the scratch Claude Code holding `done` | Record after |
| --- | --- |
| `session.focus_block` away and back, session not on screen | `done` |
| `block.event` focus `out` then `in` | `done` |
| the Rex app shows the session (`client.perform` → `session.select`), block focused | `done` |
| key presses into it while shown (`space`, `backspace`) | `done` |

Claude Code leaves `done` only when it starts its next turn. The specification leaves this to the terminal ("the terminal decides when
to stop showing them, for example when the user returns to the terminal and presses a key",
**[P]**), and this server's answer is: never, on its own. A record changes only when its
program reports again or clears it.

**Consequence for the design.** On herdr, focusing a `done` agent turns it `idle` — the
`done` tier is *self-consuming* ([#6](https://github.com/sigma/sd-herdr/issues/6)), which is
why only the `blocked` tier needs a visited set. **On Rex, a press does not consume `done`.**
The agent leaves `done` when the user gives it its next instruction (Claude Code then
reports `working`, §4), not when the button takes them there. If nothing else changes, a
Rex `done` agent behaves under the press like a `blocked` one: the cycle needs the visited
set for both tiers, or the press would land on the same `done` agent forever.

The plugin cannot clear the record itself: the terminal's methods offer no way to write
program status, and the protocol says "there is no way to read records" from inside the
terminal **[P]**. Writing an OSC 7501 `clear` into the agent's terminal would mean typing
into the user's agent, which is out of the question.

## 2. `working` and `blocked` live only as long as their process holds the foreground

**[V]**
- A `working` report from a foreground process (`sh report.sh …; sleep 30`) holds until the
  process is interrupted; `ctrl+c` returns to the prompt and the record goes with
  `program_status_removed {reason: "prompt"}`.
- A `blocked` report from a process that exits straight back to the prompt is removed at
  once, same reason. Child records follow the same rule: in a batch of root `idle`, child
  `w1` `blocked` and child `w2` `done`, only `w1` was removed at the prompt.
- `done` and `error` survive both the prompt and the exit of the process that reported them
  (the last step: `sh -c '… state=done'` exited, the record stayed).

This matches the specification's lifetime table **[P]**. For an agent it means a stale
`blocked` cannot outlive the agent's process: a crashed or killed Claude Code takes its
`blocked` with it, while its last `done` remains.

## 3. Ordering: `updated_at` is the time of the last report, not of the state change

**[V]** Reporting `done` twice moved `updated_at` forward (`…:47.98` → `…:49.21`) and sent
a second `program_status_changed` with the same state. The record carries no "since" field.

**[O]** Claude Code does not re-report: across this session it sent one report per
transition (`working` at the start of a turn, `blocked` when it asked a question, `working`
again on the answer), with nothing in between, so for Claude Code `updated_at` *is* the
time the state was entered.

**Recommendation.** Use `updated_at` as the longest-wait key, but do not lean on it being a
"since": a program that re-reports the same state would jump to the back of its tier. If
that turns out to matter, the plugin can keep its own first-seen time per
`(block, state)`, which costs one map. Unlike herdr's `state_change_seq`, `updated_at` is
wall-clock time and stays comparable across server restarts.

## 4. What Claude Code reports

**[O]** Root record only (no `id`), `app: "claude-code"`, `owner {name: "claude"}`:

| When | `state` | Notes |
| --- | --- | --- |
| a turn starts | `working` | no `progress` |
| it asks the user a question | `blocked` | `kind: "question"`, `msg` holds the question and its options as plain text |
| the question is answered | `working` | |
| the turn ends | `done` | **[C]** ~1 s after `working` for a one-word answer; also seen on a live agent left `done` for ~40 min |

The listener's absence of reports while the agent worked confirms there is no heartbeat.
Another live agent read `idle` with no turn after it; the protocol asks programs to report
`idle` when the user interrupts, which may explain it — not verified. Not observed: a
permission prompt (`kind: "permission"` expected) or an error.

The only Rex hook configured for Claude Code here is `rex __internal session-start`; the
status reports come from Claude Code itself.

## 5. Collapsing records to one agent status

**[V]** Records nest by `id` (`build`, `build/test`), and a child without `app` inherits
`effective_app` from its nearest ancestor (`w2` reported no `app` and read back as
`done@probe`). Recommended rule for the backend:

- A block is an **agent** if any of its records has an `effective_app`. The `app` value
  (`claude-code`, …) plays the role of herdr's `agent` field: the plugin does not filter
  on it, just as it does not filter on herdr's agent kind.
- Its status is the **most urgent** state among those records, in the tile's own tier order,
  with `error` ranked as `blocked` (map decision). Its ordering key is that record's
  `updated_at`.
- A state the plugin does not know is read as `idle`, as the schema requires.

## 6. Not measured

- Whether the Rex app's own status markers (session picker, unfocused tabs) disappear once
  the user has seen a `done` agent. They are drawn by the app; the server record they would
  be drawn from stays `done` (§1), and the tile reads the server. If the app does hide them,
  the tile and the app disagree about a seen `done` agent: the tile stays green until the
  agent's next turn.
- Permission prompts and `error` from a real agent (§4).
