# Does a *detected* agent re-establish itself after a server lifetime boundary?

Measurements taken while resolving [sigma/sd-herdr#13](https://github.com/sigma/sd-herdr/issues/13)
(map: #1). Amends [herdr-restart-settling.md](herdr-restart-settling.md) §3–§4, which
established that *reported* agent state never repopulates, and closes the `[U]` left by
[herdr-focus-contract.md](herdr-focus-contract.md) §6 and §9.

**Subject**: herdr `0.8.0`, protocol `19`, macOS (darwin 25.5.0), Python `3.14.7` poller,
`claude` (Opus 5) as the detected agent. Source read at tag `v0.8.0` in the herdr
checkout at `/Users/yann/src/github.com/ogulcancelik/herdr`.

**Method**: a throwaway session `sdscratch13` (`herdr --session sdscratch13 server`,
headless), one workspace, two tabs, one pane each, each running a real `claude` process
started with `herdr pane run`. Both agents were **detected**, never reported — no
`pane.report_agent` call was made in this session at all. A poller issued
`session.snapshot` every 100 ms on its own short-lived connection (10× the plugin's
planned 1 s cadence), recording outcome, `agents[]`, per-pane `agent_status`, and
`terminal_id`. Five 25–30 s runs were driven, each firing its boundary 2.0 s into the
window: three `server.live_handoff` runs with the agents in different states, one
`server.stop`+restart, one exploratory handoff discarded to a width artefact (§7). Both
agents were **silent across every boundary** — one sitting at a Claude Code prompt, one
parked on a permission prompt — so nothing in these runs is output-driven by
construction. Process lineage was checked with `ps` before and after each boundary. The
session was stopped and deleted afterwards; the user's `default` session was never
touched.

Evidence key as in the sibling docs: **[V]** verified by execution, **[D]** from the
bundled schema, **[U]** unverified.

---

## 1. Detection *does* re-fire after a live handoff, in ~0.4 s — [V]

A `server.live_handoff` destroys and rebuilds every agent record, and then **re-detects
it from scratch**, reliably and fast. Three independent runs, each with the handoff
issued at t = 2.0 s:

| run | agents state before | handoff issued | last good sample | socket gap | first sample with panes but **`agents[] == []`** | first sample with agents back | Δ from handoff |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C | `p1 idle`, `p3 blocked` | 2005 ms | 1974 ms | `ENOENT` @ 2080 (1 sample) | 2185 ms | **2395 ms** | **390 ms** |
| D | `p1 idle`, `p3 blocked` | 2001 ms | 1974 ms | `ENOENT` @ 2092 (1 sample) | 2197 ms | **2406 ms** | **405 ms** |
| E | `p1 idle`, `p3 done` | 2000 ms | 1975 ms | `ENOENT` @ 2086 (1 sample) | 2191 ms | **2401 ms** | **401 ms** |

The `agents[]`-empty window — panes present, agents gone — is **314–315 ms** in all
three runs, and the whole excursion from handoff request to a repopulated `agents[]` is
**390–405 ms**. `terminal_id` was regenerated for every pane at the boundary, exactly as
herdr-restart-settling.md §1 describes, so the plugin's restart marker fires on the same
snapshot that already shows the empty `agents[]`.

This directly contradicts the generalisation in herdr-restart-settling.md §3 ("agent
state does not repopulate on its own"). That claim is true of *reported* agents and
false of *detected* ones.

## 2. Detection does **not** re-fire after `server.stop` + restart — because the agent is dead — [V]

Run B, `server.stop` at 2004 ms and a fresh `herdr --session sdscratch13 server` spawned
at 3318 ms:

| t (ms) | outcome | panes | per-pane `agent_status` | `agents[]` |
| --- | --- | --- | --- | --- |
| 0 – 1979 | ok | 2 | `p1 idle`, `p3 blocked` | 2 entries, both `claude` |
| 2083 | `error:server_unavailable` | — | — | — |
| 2888 – 3300 | `ENOENT` (5 samples) | — | — | — |
| 3406 – 29952 | ok | 2 | `p1 unknown`, `p3 unknown` | **`[]` for the remaining 26.5 s** |

The reason is structural, not a settling delay: **a clean stop kills the pane's whole
process session.** Before the run, the scratch server owned two `-zsh` children hosting
`claude` PIDs 42673 and 43233; after the restart all four PIDs were gone and the restored
panes hosted brand-new `-zsh` shells at an empty prompt (verified by `ps` and
`herdr pane read`). Source confirms this is deliberate: `shutdown_pane_processes`
(`src/pane.rs:1229`) collects `session_processes(child_pid)` and walks
`Hangup → Terminate → Kill` with a 250 ms grace at each step, and `Method::ServerStop`
simply sets `should_quit` (`src/app/api.rs:904`), which runs that shutdown for every
pane.

So for a stop/restart the correct statement is not "detection is slow" but **"there is
nothing left to detect"**. herdr-restart-settling.md §3's conclusion holds unchanged for
this boundary, and for a stronger reason than it gave.

By contrast, a live handoff passes the PTYs to the successor: the pane shells and their
`claude` children survived every handoff in runs A, C, D and E, reparented to `launchd`
(ppid 1) as the old server exited. The two scratch `claude` processes survived three
consecutive handoffs.

## 3. During the gap the agent is **absent from `agents[]`**, not `unknown` — [V]

In every run, at both boundary shapes, the intermediate samples show:

```
"panes":   2 entries, agent_status "unknown"
"agents":  []
```

`agents[]` is empty, not populated with `unknown` rows. This matches
herdr-socket-api.md §2 (`agents[]` is pre-filtered to panes hosting an agent) and it
settles issue #13's question 3: the attention set during the gap is **empty**, so it
renders **dark**, not grey. The `unknown`-only-set-renders-grey rule from #9 is never
reached by a restart.

## 4. Re-detection is **process-driven and timer-driven**, not output-driven — [V][S]

This is the question that mattered most, and source and measurement agree.

**Identity** comes from a kernel process query, not the screen. The per-pane detection
task (`src/pane.rs:2075`–`2270`) ticks on a fixed timer — `TICK_UNIDENTIFIED` 500 ms,
`TICK_IDENTIFIED` 300 ms, after a 50 ms initial sleep — and on each tick calls
`detect::foreground_process_group_id(pid)` and, when `should_probe_foreground_job` says
so, `detect::foreground_job(pid)` → `detect::identify_agent_in_job`
(`src/detect/mod.rs:210`, `:308`, `:322`). `should_probe_foreground_job`
(`src/pane.rs:412`) returns `true` unconditionally on the first tick of a fresh task,
because `has_process_probe` is `false`. No pane output is consulted anywhere on that
path.

**Measured**: both agents were silent across the boundary in runs C, D and E — one had
printed nothing since its prompt appeared minutes earlier, the other was parked on a
Claude Code permission prompt — and both were re-detected in 390–405 ms every time (§1).
An idle, quiet agent is re-detected on the timer alone.

The screen is used only for *state*, and even there the post-handoff re-read is forced
by a timer rather than by output. On re-detection the task clears
`last_screen_scan_detection_content_seq` to `None` and sets
`agent_startup_grace_until = now + AGENT_STARTUP_GRACE_WINDOW`
(`src/pane.rs:2255`–`2261`); every tick inside the grace window `continue`s before the
screen read (`src/pane.rs:2323`–`2335`), so that `None` is still in place when the window
expires. The next tick therefore compares `None` against `Some(seq)` and takes the `Read`
branch of `decide_detection_screen_read` regardless of whether the content sequence ever
moved (`src/pane/agent_detection.rs:90`–`136`).

**So the gap is bounded, and the "unbounded quiet-agent" fear in #13 does not
materialise.**

## 5. But the status is **wrong for ~3.3 s** after re-detection — [V][S]

The catch, and the finding that actually moves the settle window. On re-detection herdr
does not read the screen — it **seeds the state to `Idle`** and publishes that
immediately (`src/pane.rs:2262`–`2276`, `state = AgentState::Idle` followed by
`publish_state_changed_event(… AgentState::Idle …)`), then suppresses all screen-derived
state for `AGENT_STARTUP_GRACE_WINDOW = 3 s`
(`src/pane/agent_detection.rs:12`, enforced at `src/pane.rs:2323`–`2335`).

Measured against a genuinely `blocked` agent (`claude` on a permission prompt, visible on
screen throughout):

| run | true state | re-detected at | reported as | corrected to `blocked` at | wrong-status window | total from handoff |
| --- | --- | --- | --- | --- | --- | --- |
| C | `blocked` | 2395 ms | `idle` | **5739 ms** | **3344 ms** | **3734 ms** |
| D | `blocked` | 2406 ms | `idle` | **5744 ms** | **3338 ms** | **3743 ms** |

The correction lands at grace-window expiry plus roughly one 300 ms tick, exactly as the
source predicts, and it needed no pane output to arrive.

Two mitigating details:

- The seeded state is reported as `idle`, **not** `done` — verified in every run, for
  both the focused and the unfocused pane. So the flash is always *toward* "no
  attention", never toward a false amber or a false red. The tile under-reports during
  the window; it never over-reports.
- `state_change_seq` restarts from 0 in the new lifetime (`p1` and `p3` came back at
  seq 1–2), so the plugin's "longest-waiting first" ordering is meaningless until the
  session has re-published, consistent with herdr-socket-api.md §2.

## 6. A live handoff silently **consumes the `done` tier** — [V]

Run E started with `p3` genuinely `done` (an unfocused pane whose agent had just
finished a task). After the handoff it came back as `idle` at 2401 ms and **stayed
`idle` for the remaining 22.5 s of the window** — 217 consecutive polls, no correction.

This is not a settling delay; it is a permanent loss. `done` is `(idle, seen == false)`
(herdr-focus-contract.md §4), and the re-detection seed publishes plain `Idle` with the
pane already counted as seen. Since the agent is quiet and its screen shows an ordinary
idle prompt, the post-grace rescan agrees with the seed and there is nothing left to
recover.

Consequence for the button: **a live handoff can wipe amber attention permanently,
without the plugin doing anything wrong.** A `blocked` agent recovers (§5) because its
blocking chrome is still on screen; a `done` agent does not, because "done" lives in
herdr's seen-flag, not on the screen. This is a herdr-side property with no plugin
lever — but it should be written down, because it is the one case where the tile goes
dark and *stays* dark while a user is still waiting on something.

## 7. Aside: pane width is part of the detection contract — [V]

Run A (discarded from the tables above) put both agents in a split within one tab. The
handoff shrank the headless server's terminal from ~107 to ~48 columns, which reflowed
the Claude Code prompt and broke the manifest match: the agent stayed reported as `idle`
for 27.5 s while visibly blocked on screen, and a keystroke that forced a redraw did not
fix it. Re-running with one full-width pane per tab (runs C–E) removed the effect
entirely.

This is a headless-only artefact of my harness — the size came from whatever terminal
launched the server — and it is not a claim about herdr under a real client. But it does
show that screen-manifest state detection is width-sensitive, so §5's 3.3 s recovery is
a floor that assumes the pane geometry survives the boundary. **[U]** whether an attached
TUI client keeps pane geometry stable across a handoff.

## 8. Consequences for the sd-herdr spec

### 8.1 `herdr-restart-settling.md` §4.4 needs amending — [V]

§4.4 currently reads: *"A dark tile after a restart is correct… The settling policy only
has to avoid flashing a wrong face during the ~180 ms–2 s transition."* That is right for
a `server.stop`+restart (§2) and **wrong for a live handoff**. The amended rule:

> **Settle for a fixed 4 s after a `terminal_id` change, not 2–3 s.**
>
> - A **stop/restart** genuinely has nothing to wait for: the agent processes are killed
>   with the server, `agents[]` is empty from the first successful poll and stays empty.
>   Dark is the truth. (§2)
> - A **live handoff** repopulates `agents[]` in **~0.4 s** and reaches *correct*
>   statuses **~3.7 s** after the boundary. (§1, §5)
>
> The two shapes are not distinguishable from the snapshot at the moment they happen —
> both show a fresh `terminal_id` under a stable `pane_id` — so one window has to cover
> both, and it must be sized for the handoff. 4 s clears the measured 3.73–3.74 s worst
> case with a small margin; 3 s would expose the wrong face on essentially every handoff.
>
> This **decouples the settle window from #7's 3 s staleness deadline**, which #9 reused
> for convenience. They now have different jobs and different numbers.

The cost of the longer hold is small and asymmetric: during settling the tile is grey
("can't see the session"), which is honest, whereas ending the hold at 3 s renders a
confident dark tile over an agent that is in fact blocked.

### 8.2 What the face should render during the gap — [V]

**Dark is not what the gap looks like — grey is what the plugin should choose.**

Finding 3 says the *data* during the gap is an empty `agents[]`, which the attention model
maps to dark. But the plugin is not obliged to render that: it knows a lifetime boundary
just happened (the `terminal_id` marker), and §5 says the data is untrustworthy for
~3.7 s afterwards. So:

- **0 – 4 s after a `terminal_id` change: grey**, the existing "cannot see the session"
  face. This covers the ~315 ms empty-`agents[]` window (§3), the ~0.4 s re-detection,
  and the ~3.3 s seeded-`idle` window (§5) in one rule.
- **After 4 s: render the snapshot as-is**, dark included. If the boundary was a
  stop/restart, dark is correct and permanent; if it was a handoff, the statuses are
  correct by then.
- **No repopulation-plausibility test.** herdr-restart-settling.md §4.3 stands: the
  plugin cannot tell the two shapes apart, so it waits a fixed time and then believes
  what it sees.

Grey is already the right face rather than a new state: #9's rule that grey is one "can't
see anything" state, not three, is unchanged — this just gives that state a slightly
longer, better-justified duration.

### 8.3 What does not change

- The restart marker stays `terminal_id` under a stable `pane_id` (§1 reconfirms it fires
  on both shapes).
- `server_unavailable` is still an error *response*; a stop/restart still adds `ENOENT`.
  A 100 ms poller saw the handoff's socket gap as exactly **one** `ENOENT` sample in each
  of runs C, D, E — so a 1 s poller will usually miss it entirely, as #9 said.
- `unknown` still renders grey when it is the whole attention set; that rule is simply
  never exercised by a restart (§3).

## 9. What this could not settle

- **[U] Behaviour with an attached TUI client.** Every run was headless, so pane geometry
  was set by the launching terminal and changed at the first handoff (§7). Under a real
  client the geometry should be the client's and stable, but that was not measured — and
  §5's 3.3 s figure assumes it.
- **[U] Agents other than `claude`.** Identity detection is process-based and
  agent-agnostic (§4), so re-detection latency should not vary; but the 3 s grace ends in
  a *screen-manifest* read, so the recovery of a `blocked` status depends on that agent's
  manifest matching its current screen. Only Claude Code's manifest was exercised.
- **[U] A `working` agent across a handoff.** Not run. Source says it takes the same
  `Idle` seed, and `working` is not in the attention set either way, so the tile-visible
  outcome should be identical — but that is reasoning, not measurement.
- **[U] Whether the `done`-tier loss in §6 is recoverable at all.** Observed for 22.5 s
  in one run. A longer window, or an agent that later prints something, might restore it;
  nothing in the source suggests a mechanism, since `seen` is not derived from the screen.
- **[U] `herdr update --handoff` and crash-restart shapes.** Only the API-driven
  `server.live_handoff` and `server.stop`+manual-restart were exercised. A crash leaves
  a stale socket (`ECONNREFUSED`, per herdr-focus-contract.md §6.3) and would orphan the
  pane processes rather than killing them, which might behave like neither shape.
