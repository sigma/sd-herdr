# The herdr focus contract, and what focusing a `done` agent really does

Research for [sigma/sd-mux#6](https://github.com/sigma/sd-mux/issues/6) (map: #1).
Builds on [herdr-socket-api.md](herdr-socket-api.md), which left every claim in this
document marked `[U]` because probing was confined to read-only calls against the
user's live session.

**Subject**: herdr `0.8.0`, protocol `19`, macOS (darwin 25.5.0), Node `v26.7.0`.

**Method**: a throwaway session `scratch6`
(`herdr --session scratch6 server`, headless, socket
`~/.config/herdr/sessions/scratch6/herdr.sock`), driven exclusively over the raw
NDJSON socket with a Node client. Two workspaces × two tabs each, agents synthesised
with `pane.report_agent` so that `blocked` and `done` panes could be parked in
non-active tabs of a non-active workspace — the exact case the Stream Deck button
hits. The session was stopped and deleted afterwards; the user's `default` session and
the concurrently-used `scratch5` were never touched.

## Evidence key

- **[V]** — VERIFIED BY EXECUTION against the installed 0.8.0 in `scratch6`.
  Every `[V]` below is a request/response pair actually observed, not a re-reading.
- **[D]** — from the installed build's own bundled schema (`herdr api schema --json`),
  i.e. authoritative for 0.8.0.
- **[S]** — INFERRED from the herdr Rust source at
  `/Users/yann/src/github.com/ogulcancelik/herdr` (`b2924877`, *ahead of* 0.8.0).
  Used only to explain *why* an observed behaviour happens, never as the sole basis
  for a contract claim.
- **[U]** — still unverified.

---

## 1. Does focusing a `done` agent flip it to `idle`? — **Yes, and the focus itself does it**

**[V] The transition is caused by the focus call, synchronously, with no user typing
involved.** The `pane.focus` *response itself* already carries the new status:

```jsonc
// before: {"pane":"w2:p2","ws":"w2","tab":"w2:t2","status":"done","seq":6,"focused":false}
--> {"id":"…","method":"pane.focus","params":{"pane_id":"w2:p2"}}
<-- {"result":{"type":"pane_info","pane":{
      "pane_id":"w2:p2","workspace_id":"w2","tab_id":"w2:t2",
      "focused":true,"agent":"claude","agent_status":"idle"}}}   // ← already idle
```

The subsequent snapshot agrees, and a `pane.agent_status_changed` event for that pane
arrives **~150 ms** later on an open subscription:

```jsonc
{"event":"pane.agent_status_changed",
 "data":{"agent":"claude","agent_status":"idle","pane_id":"w2:p2","workspace_id":"w2"}}
```
[V]

The same holds for `agent.focus` — by pane id and by name (§3). [V]

**No user interaction is required.** Nothing was typed into any pane during any of
these runs; the panes ran a bare shell. This is the load-bearing answer for the
two-tier press: a button that focuses on the user's behalf **does** consume the
`done` tier, exactly as map #1 assumed.

### 1a. Why: `done` is `idle` + `!seen`, and focus marks the whole active tab seen

`done` is not a state an agent can be in — it is a *rendering* of `(state = Idle,
seen = false)`:

- **[D]** The installed schema has two distinct enums. `PaneAgentState`, what a client
  may *report*, is `["idle","working","blocked","unknown"]` — **there is no reportable
  `done`**. `AgentStatus`, what the API *reports back*, is
  `["idle","working","blocked","done","unknown"]`.
- **[S]** `pane_agent_status(state, seen)` maps `(Idle, false) => Done`,
  `(Idle, true) => Idle` (`src/app/api_helpers.rs`).
- **[S]** Both `handle_pane_focus` (`src/app/api/panes.rs`) and `focus_agent_target`
  (`src/app/agents.rs`) call `self.state.mark_active_tab_seen()` immediately after
  `focus_pane_in_workspace`, and that helper sets `seen = true` on **every pane in the
  newly-active tab**.

Two verified consequences fall straight out of that:

**[V] `state_change_seq` does not move.** `w2:p2` went `done → idle` with
`state_change_seq` pinned at `6` throughout. The `done`-tier consumption is therefore
invisible to any logic keyed on `state_change_seq`; only the status field changes.

**[V] ⚠️ Focus clears `done` for *every* agent in the target's tab, not just the
target.** With `w2:p1` and `w2:p3` both `done` in the same tab `w2:t1`, focusing
`w2:p1` alone flipped **both** to `idle`:

```
before: w1:p2:blocked  w2:p1:done  w2:p3:done  w2:p2:done
pane.focus w2:p1
after : w1:p2:blocked  w2:p1:idle  w2:p3:idle  w2:p2:done   ← w2:p3 cleared as collateral
```

Scope is the **active tab only** — `w2:p2`, in the *other* tab of the *same* workspace
that focus had just switched to, stayed `done`. [V]

So a single press can consume more than one `done` agent. The plugin must not assume
"one press removes exactly one item"; the post-focus re-snapshot already decided in
map #1 is what keeps the face honest, and it is now a hard requirement rather than an
optimisation.

### 1b. ⚠️ A completion inside the active tab may never surface as `done` at all

**[V]** An agent parked `working → idle` while its pane sat in the **focused** tab went
straight to `idle` and never showed `done`. The identical sequence on the same pane,
while a different tab was active, produced `done`.

**[S]** The gate is
`active_tab_suppresses_notifications(is_active_tab, outer_terminal_focus)
= is_active_tab && outer_terminal_focus != Some(false)` (`src/app/actions.rs`), applied
to completion transitions in `apply_pane_state_change`. `outer_terminal_focus` is
reported by an attached TUI client; the headless `scratch6` server had none, so it was
`None`, which the expression treats as "not suppressed → mark seen".

**Practical reading for the plugin**: `done` means "finished *and* the user was not
looking". That is precisely the attention semantic map #1 wants, and it means the tile
will not light up for an agent that completed under the user's nose. It also means the
`done` tier is genuinely self-consuming from more than one direction — herdr clears it
on ordinary attention too, not only via the API.

### 1c. ⚠️ Ordering hazard: raise the window *after* focusing, not before

**[S]** `src/app/runtime.rs` sets `outer_terminal_focus = Some(true)` and calls
`mark_active_tab_seen()` when the TUI client sees its terminal gain focus.

A press that raises the host terminal window **first** therefore marks the
*previously* active tab seen, silently consuming a `done` agent the user never looked
at. Focusing the target pane first and raising the window second marks the *intended*
tab seen, which is what the press means anyway. **Focus, then raise.** [S] — not
executed; `scratch6` was headless and had no window.

---

## 2. `pane.focus` cross-workspace: one call, no chaining — **confirmed**

**[V]** Starting focus at `w1:t1 / w1:p1`, a single request:

```json
{"id":"…","method":"pane.focus","params":{"pane_id":"w2:p2"}}
```

moved focus to a pane in a **non-active tab (`w2:t2`) of a non-active workspace
(`w2`)** in one shot:

| | workspace | tab | pane |
|---|---|---|---|
| before | `w1` | `w1:t1` | `w1:p1` |
| after | `w2` | `w2:t2` | `w2:p2` |

No `workspace.focus` and no `tab.focus` were sent. Verified in both directions
(`w1 → w2` and `w2 → w1`) and across three further presses in the §5 simulation. The
`[S][U]` claim in herdr-socket-api.md §4b is now **[V] for the installed 0.8.0**.

Response is `{"type":"pane_info","pane":{…}}`, carrying the post-focus
`workspace_id`, `tab_id`, `focused: true` and the updated `agent_status` — so a client
gets the outcome without a follow-up read (though it still needs a full snapshot to
re-rank the attention set).

**[V] Re-focusing the already-focused pane is a successful no-op**: repeated
`pane.focus` on the focused, `blocked` pane returned `pane_info` with
`focused: true, agent_status: "blocked"` every time, no error, and emitted no event.
Map #1's "with exactly one blocked agent, re-press re-focuses it" is safe.

**[V] Focusing a `blocked` agent leaves it `blocked` and emits no event at all.** The
subscription stayed silent across the whole call. This is the asymmetry the two-tier
design rests on, and it is confirmed. It is also why the post-focus re-snapshot is
mandatory: for the `blocked` tier there is *no* event to drive a re-render.

**[V] `pane.focus` will not take a tab id**: `{"pane_id":"w2:t1"}` →
`pane_not_found`.

---

## 3. `agent.focus` by unique name — **behaves as documented**

**[V]** After `agent.rename` gave `w2:p1` the name `beta`:

```jsonc
--> {"method":"agent.focus","params":{"target":"beta"}}
<-- {"result":{"type":"agent_info","agent":{
      "name":"beta","agent":"claude","agent_status":"idle",   // ← was "done"
      "workspace_id":"w2","tab_id":"w2:t1","pane_id":"w2:p1","focused":true,
      "state_change_seq":4,"terminal_id":"term_…"}}}
```

Cross-workspace, cross-tab, single call, and it clears `done` exactly like
`pane.focus`. [V]

Accepted and rejected targets, all executed:

| `target` | Result | Tag |
|---|---|---|
| unique agent **name** (`"beta"`) | `agent_info`, focus moves | [V] |
| **pane id** of an agent pane (`"w2:p1"`) | `agent_info`, focus moves | [V] |
| pane id of a pane with **no agent** (`"w1:p1"`) | `{"code":"agent_not_found","message":"agent target w1:p1 not found"}` | [V] |
| **`terminal_id`** (`"term_6593c245649e01"`) | `agent_not_found` | [V] |
| unknown name (`"nosuchagent"`) | `agent_not_found` | [V] |
| well-formed but dead pane id | `agent_not_found` | [V] |

**[V] ⚠️ `agent_target_ambiguous` looks unreachable via renames.** Trying to give a
second agent an existing name is rejected *at rename time*:

```json
{"code":"agent_name_taken",
 "message":"agent name beta is already used; candidates: terminal_id=… pane_id=w2:p1 workspace_id=w2 tab_id=w2:t1 cwd=/Users/yann status=Idle"}
```

So herdr enforces name uniqueness up front. Ambiguity presumably remains reachable
through other target forms [U], but the practical hazard is smaller than
herdr-socket-api.md §5a assumed.

**Recommendation unchanged**: prefer `pane.focus`. It is keyed on the id the plugin
already holds from the snapshot, has one failure mode instead of three, and needs no
name-resolution round trip.

---

## 4. Focusing a pane that died between snapshot and press — **clean `pane_not_found`**

Tested against a pane (`w2:p3`) that was really split into existence, given an agent,
then closed with `pane.close`:

| Call | Response | Tag |
|---|---|---|
| `pane.focus {"pane_id":"w2:p3"}` (really dead) | `{"code":"pane_not_found","message":"pane w2:p3 not found"}` | [V] |
| `agent.focus {"target":"w2:p3"}` (really dead) | `{"code":"agent_not_found","message":"agent target w2:p3 not found"}` | [V] |
| `pane.get {"pane_id":"w2:p3"}` | `pane_not_found` | [V] |
| `pane.focus` with a never-existing id `"w9:p9"` | `pane_not_found` | [V] |
| `pane.focus` with `"garbage"` | `{"code":"pane_not_found","message":"pane garbage not found"}` | [V] |
| `pane.focus` with `""` | `{"code":"pane_not_found","message":"pane  not found"}` | [V] |

**Nothing worse than an error.** [V] No crash, no partial focus, no workspace switch,
no server-side state change: focus stayed exactly where it was, and the surviving
agents' statuses were untouched. The connection closed normally, as every request
connection does.

Malformed, never-existent and recently-dead ids are **indistinguishable** — all
`pane_not_found`. [V] The correct client reaction is identical in all three cases:
discard the cursor, re-snapshot, and (per map #1's cycle rules) treat it as a
membership change.

---

## 5. The two-tier press, simulated end to end — **it survives**

Ran the map's press reducer against `scratch6` with one `blocked` and two `done`
agents spread over two workspaces. Attention ordering:
`blocked → done → unknown`, then lowest `state_change_seq`. [V]

```
start   w1:p1:done  w1:p2:blocked  w2:p1:idle  w2:p2:done      focus=w1:t2/w1:p2
press 1 set=[w1:p2:blocked, w2:p2:done, w1:p1:done] -> w1:p2   resp status=blocked  (unchanged)
press 2 set=[w1:p2:blocked, w2:p2:done, w1:p1:done] -> w2:p2   resp status=idle     (consumed)
press 3 set=[w1:p2:blocked, w1:p1:done]             -> w1:p2   resp status=blocked
press 4 set=[w1:p2:blocked, w1:p1:done]             -> w1:p1   resp status=idle     (consumed)
press 5 set=[w1:p2:blocked]                         -> w1:p2   resp status=blocked
```

Every press landed the right pane, cross-workspace, in one call, and the attention set
drained monotonically to the single un-clearable `blocked` agent. [V]

**⚠️ One design bug found, in the reducer rather than in herdr.** Map #1 states both
"visited-set resets on wrap" and "with exactly one blocked agent, re-press re-focuses
it". Implemented literally, those two rules together mean the `blocked` tier **never
yields**: with a single blocked agent, the wrap immediately re-selects it, and the
`done` tier is unreachable forever. Verified by running that reducer — five presses,
all five on `w1:p2`, while two `done` agents sat ignored. [V]

The fix is a precedence order, not a new rule: **on wrap, fall through to the `done`
tier if it is non-empty; only re-select the blocked agent when `done` is empty.** With
that ordering the trace above is what you get. This needs to be explicit in the spec —
it is exactly the kind of thing an implementer will get wrong.

Second-order note from the same trace: because consuming a `done` agent changes the
attention set, the visited-set resets, and the next press goes back to the top of the
`blocked` tier. Presses therefore *interleave* blocked and done rather than strictly
draining blocked first. That is arguably the better behaviour — the most urgent thing
is always one press away — but it is not what "drain all blocked, then drain done"
describes, and the spec should say which it wants.

---

## 6. `server.stop` — real behaviour

Executed against `scratch6` with a live subscription connection open. [V]

1. `{"method":"server.stop","params":{}}` returns `{"result":{"type":"ok"}}` on the
   requesting connection after **~106 ms**, *before* shutdown completes. The response
   is not a promise that the server is gone.
2. The **subscription connection** received **no error line and no notice** — just
   `end` → `close` with `hadError === false`, ~1.7 s after the subscription started
   (≈0.6 s after the stop). **Indistinguishable from a normal close.** [V]
   This upgrades herdr-socket-api.md §5b from "confirmed via an identical teardown
   path" to directly verified: *any* unexpected close on the subscription socket must
   be read as "connection lost → grey face → reconnect", never as "all clear".
3. The socket file is **unlinked** within ~300 ms. Every reconnect attempt afterwards
   failed with **`ENOENT`**, not `ECONNREFUSED`, at +0.3 s, +0.9 s, +2.4 s and +5.4 s.
   [V] `ECONNREFUSED` is the *stale-file* case (crash / SIGKILL), not the clean-stop
   case.
4. Server-side, `server.stop` **kills the panes**: the log shows
   `pane session terminated … signal=Hangup` for all four panes, and a
   `persist.save` of `session.json` first. [V]
5. **Session state persists, agent state does not.** Restarting `scratch6` restored
   both workspaces, their labels, all tabs and panes, and the focused
   workspace/tab/pane — but `agents[]` came back **empty**. [V] Agent identity
   reported via `pane.report_agent` is not persisted. (Whether a *detected* agent is
   re-detected on restart is [U] — the panes here hosted bare shells with synthesised
   agent reports.)

---

## 7. Does a subscription survive a live handoff? — **No**

`server.live_handoff` is a real API method in 0.8.0 (`ServerLiveHandoffParams`:
optional `expected_version`, `expected_protocol`, `import_exe`) [D], and
`ping.capabilities.live_handoff` was `true`. Executed with an open subscription and
`{"expected_version":"0.8.0","expected_protocol":19}`. [V]

- Response `{"type":"ok"}`, immediately.
- The old server re-exec'd into a new process, importing the panes:
  `handoff import ready panes=4` → `api server listening path=…/herdr.sock` →
  `live handoff completed; old server exiting`. [V]
- **The subscription connection died**: `end` → `close hadError=false` at +1.33 s. No
  error line, no warning, no resumption. Same undetectable-close shape as §6. [V]
- **The socket path is unchanged** and a plain `ping` succeeded ~1 s later. So a
  reconnect loop recovers on the same path — but it must actually notice the close.
- `capabilities.detached_server_daemon` flipped `false → true` across the handoff [V],
  so capability flags are not stable across a server's lifetime. `version` and
  `protocol` were unchanged here because the handoff re-exec'd the same binary; a real
  update would change them, which is the argument for re-`ping`ing on every reconnect.
- **Agent state did not survive.** Before: four agents (`idle`/`blocked`/`idle`/`idle`).
  After: `w1:p1` and `w1:p2` had **vanished from `agents[]` entirely**, and `w2:p1` /
  `w2:p2` came back as `agent_status: "unknown"` with `state_change_seq: 0` — names
  preserved, state lost. [V] Focused workspace/tab/pane survived intact. [V]
  The `state_change_seq` reset confirms herdr-socket-api.md §2's `[S]` caveat that
  ordering is only meaningful within one server lifetime — and "one lifetime" ends at
  a handoff, not just at a stop.

**Consequence for the plugin**: a live handoff looks exactly like a server restart from
the outside — dead subscription, same socket path, and a snapshot that is *wrong for a
few seconds* (agents missing or `unknown`) before real state re-establishes. A single
post-reconnect snapshot showing an empty attention set must therefore **not** be
rendered as "all clear" the way a genuinely empty set is; the grey/dark distinction
from map #1 should hold until at least one snapshot looks plausible, or the face
should settle over a couple of polls.

---

## 8. Consequences for the sd-herdr spec

1. **The two-tier press design survives.** Focusing a `done` agent flips it to `idle`
   synchronously, on the focus itself, with no user typing — so the tier really is
   self-consuming. Focusing a `blocked` agent changes nothing and emits nothing — so
   that tier really does need a visited-set. [V]
2. **A press can consume more than one `done` agent** (all agents in the target's tab).
   Never model the press as removing exactly one item; re-snapshot and re-rank. [V]
3. **`state_change_seq` does not change on the `done → idle` flip.** Consumption is
   detectable only by the status field or the `pane.agent_status_changed` event. [V]
4. **Fix the wrap rule.** "Reset the visited-set on wrap" must be ordered *after*
   "fall through to `done`", or a lone `blocked` agent starves the `done` tier
   forever. [V]
5. **`pane.focus` is a one-call, cross-workspace primitive** with a clean, uniform
   error (`pane_not_found`) for anything it cannot resolve. Use it; skip `agent.focus`.
   [V]
6. **Focus first, raise the window second** — raising first makes the TUI mark the
   *old* active tab seen, consuming an unrelated `done`. [S]
7. **`done` already means "the user wasn't looking"**; herdr suppresses it for
   completions in the focused tab. The attention model does not need to re-derive
   that. [V]
8. **Handoff and stop are the same client-side event**: a silent, error-free close.
   Detect on `close`, reconnect on the same path, re-`ping` for version/protocol, and
   distrust the first snapshot after reconnect. [V]

## 9. Still open

- **[U]** Everything above was measured against a **headless** server with no attached
  TUI client, so `outer_terminal_focus` was always `None`. The focus handlers call
  `mark_active_tab_seen()` unconditionally [S], so §1 should be client-independent —
  but the *suppression* behaviour of §1b, and the raise-order hazard of §1c, both hinge
  on a client reporting terminal focus and were not exercised.
- **[U]** All agents were synthesised via `pane.report_agent`. A real detected agent
  (claude in a pane, scraped from output) was never exercised; in particular, whether
  detection-based agents are re-established after a restart or handoff is untested.
- **[U]** `agent_target_ambiguous` — unreachable through `agent.rename`
  (`agent_name_taken` blocks it), so its wire shape remains unobserved.
- **[U]** The exact width of the socket-unavailable window during a live handoff. A
  `ping` at +1 s succeeded; nothing finer was measured.
