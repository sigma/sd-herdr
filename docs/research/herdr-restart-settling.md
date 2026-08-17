# What a herdr restart looks like to a polling client

Measurements taken while resolving [sigma/sd-herdr#9](https://github.com/sigma/sd-herdr/issues/9)
(map: #1). Extends [herdr-focus-contract.md](herdr-focus-contract.md) §6–§7, which
established *that* agent state is lost across a restart but not what a polling client
observes while it happens.

**Subject**: herdr `0.8.0`, protocol `19`, macOS (darwin 25.5.0), Node `v26.7.0`.

**Method**: a throwaway session `sdscratch9` (`herdr --session sdscratch9 server`,
headless), five panes across three tabs, agents synthesised with `pane.report_agent`.
A poller issued `session.snapshot` every 100 ms on its own short-lived connection —
ten times the plugin's planned 1 s cadence, so the transition is sampled finely enough
to bound it. `server.live_handoff` and `server.stop`+restart were each driven 1 s into
a 20 s polling window. The session was stopped and deleted afterwards; the user's
`default` session was never touched.

Evidence key as in herdr-focus-contract.md: **[V]** verified by execution,
**[D]** from the bundled schema, **[U]** unverified.

---

## 1. `terminal_id` is a per-server-lifetime marker — [V]

`pane_id` is stable across both a live handoff and a stop/restart; **`terminal_id` is
regenerated every server lifetime**, for every pane, while the pane itself persists.

```
                  w1:p1 terminal_id
baseline          term_6593dcd49f0fd1
after handoff     term_6593dd1f97d2b1     ← pane_id unchanged
after restart     term_6593dd3644fe01     ← pane_id unchanged
```

All five panes changed together, both times. Within a lifetime the value was constant
across every one of ~200 polls. [V]

This is the **exact restart detector** the plugin needs, and it rides in the snapshot
that is already being polled — no extra call, no heuristic. Keyed by `pane_id`, it is
unambiguous: a genuinely new pane brings a new `pane_id` too.

It is strictly better than the `state_change_seq`-regression rule adopted in
[#7](https://github.com/sigma/sd-herdr/issues/7), which fails in two observed cases —
when every agent vanishes there is no seq left to regress, and a restart of a session
whose max seq was already 0 moves nothing.

**[U]** Whether `terminal_id` is stable across a *pane* restart within one server
lifetime was not exercised. It should be, since the pane is what carries it, but the
plugin only ever compares under a stable `pane_id`.

## 2. Both restart shapes leave a connection-level trace, but the handoff's is too narrow to catch — [V]

| event | observed sequence | socket-unavailable window |
| --- | --- | --- |
| `server.live_handoff` | `server_unavailable` → success | **~180 ms** (a single 100 ms poll) |
| `server.stop` + restart | `server_unavailable` → `ENOENT` → success | **~2 s**, ending within ~150 ms of the restart |

Two consequences:

- **`server_unavailable` is a well-formed herdr *error response*, not a socket error.**
  A client that only splits "socket threw" from "got a line back" classifies it as
  neither. It needs explicit handling.
- **A 1 s poller will usually sail straight through a live handoff**, seeing no
  connection-level trace at all — just a clean, successful, *wrong* snapshot. The trace
  exists but cannot be relied on. This is why §1's data-derived marker is the primary
  signal and these errors are only corroborating.

`ENOENT` remains the clean-stop marker (`ECONNREFUSED` is the crash/stale-file case),
consistent with herdr-focus-contract.md §6.3.

## 3. Agent state does not repopulate on its own — [V]

The load-bearing result. After the handoff, `agents[]` went to **0 and stayed 0 for the
full 20 s**. Same after the stop/restart. It never came back.

The agents here were *reported* via `pane.report_agent`, and nothing re-reported them.
That generalises: **herdr does not restore agent identity — it depends entirely on
whoever owns the pane re-asserting it**, by re-detection or by re-reporting. Topology
(workspaces, tabs, panes, focus) persists; agent identity does not.

So a settling policy premised on "wait for the session to repopulate" has **no bounded
answer from herdr's side**. There may be nothing to wait for, in which case a dark tile
after a restart is not a lie — it is the truth about a herdr that has forgotten its
agents.

**[U]** Whether a *detected* agent (scraped from pane output, rather than reported)
re-establishes itself after a restart or handoff, and how quickly. This is the same gap
herdr-focus-contract.md left open, and it is now the one input that would justify
lengthening the settle window. Tracked as
[#13](https://github.com/sigma/sd-herdr/issues/13).

## 4. Consequences for the sd-herdr spec

1. **Restart detection**: `terminal_id` changed under a stable `pane_id`. Requires the
   plugin to retain the previous snapshot's `pane_id → terminal_id` map, which the
   #7 architecture does not currently carry. Restate #7's visited-set reset trigger in
   these terms.
2. **Handle `server_unavailable` explicitly** as a third outcome alongside success and
   socket error.
3. **Don't build a repopulation-plausibility test.** It may never fire. The settle
   window is a fixed timer, and a short one.
4. **A dark tile after a restart is correct**, not a failure to be papered over. The
   settling policy only has to avoid flashing a wrong face during the ~180 ms–2 s
   transition — a much smaller job than #9 assumed when it was written.
