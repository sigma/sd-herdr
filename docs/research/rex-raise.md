# How a press focuses a Rex block and brings it forward

Research for [sigma/sd-herdr#33](https://github.com/sigma/sd-herdr/issues/33) (map:
[#29](https://github.com/sigma/sd-herdr/issues/29)).

**Subject**: Rex server `0.0.1793890641-gaf0c20` (API revision 11), Rex Beta app
`0.1.0 (1829)` with **one** app window, AeroSpace, macOS. Driven from a throwaway session
with two windows: `agent` (blocks A, B) and `other` (block C). The app's displayed tab was
read from its window title through `aerospace list-windows`.

## 1. ⚠️ The app's displayed tab and the server's active window are independent

| Call | Server `active_window_id` | App shows |
| --- | --- | --- |
| app `session.select {window_id: W1}` | W2, unchanged | `agent` (W1) |
| server `session.focus_block C` (in W2) | W2 | `agent`, unchanged |
| server `session.focus_window W1` | W1 | `agent` |
| app `session.select {window_id: W2}` | W1, unchanged | `other` (W2) |
| app `session.select` without `window_id` | W1 | `other`, unchanged |

So neither half moves the other. `session.focus_block` makes a block the focused block of
its window and makes that window the session's active one, but **the app does not follow**.
`session.select` on the app client switches what the app shows, but **does not update the
server**.

## 2. The raise

A press needs three calls, all on the plugin's existing control connection:

1. `session.focus_block {session_id, block_id}` — the server side: the block becomes its
   window's focused block. Run on the server in order with other focus calls, and fails
   with `not_found` if the block closed since the snapshot.
2. `client.perform {client_id: <app>, action: "session.select", args: {session_id, window_id}}`
   — the app side: the app shows that session and **that tab**. Pass `window_id`. Without it
   the app keeps whatever tab it last showed for the session. The result is
   `{performed_by}`, and the app took ownership of the shown blocks (`block_owner_changed`,
   reason `request`/`take`).
3. Bring the app to the front, with one of the two rungs below.

Not verified: that the app's *focused pane* inside the shown tab follows the server's
`focused_block_id`. That needs a check of where typed input lands.

**Which client is "the app"**: `client.list` entries with `info.kind == "app"` and
`connection_state == "connected"`. With exactly one, use it. Several (a second Mac, a paired
phone) was not tested; a local one is recognisable by `principal.transport == "unix"`.

## 3. Bringing Rex forward

| Rung | Result | Grant needed |
| --- | --- | --- |
| `open -b com.superlogical.rex` | Rex frontmost; AeroSpace switched from workspace T to Rex's workspace E | none |
| `aerospace focus --window-id <id>` | Rex frontmost, same switch | none |

- The bundle id is **`com.superlogical.rex`**, Rex Beta included.
- The Rex window's title is **`<tab label> - <session label>`** for whatever it displays
  (`agent - sd-herdr`, then `other - sd-herdr` after selecting W2), so AeroSpace finds it
  after step 2 by matching the title's suffix. That is herdr's nonce trick
  ([#3](https://github.com/sigma/sd-herdr/issues/3), [#5](https://github.com/sigma/sd-herdr/issues/5))
  with nothing to write: Rex puts the session in the title by itself. Session labels are
  not unique, though, and Rex changes them on its own (see
  [rex-displayed-session.md](rex-displayed-session.md)), so a match is only reliable with one
  Rex window or distinct labels.
- With **one** Rex window, `open -b` is exact: there is no wrong window to front, which was
  the failure that made the herdr ladder decline under a tiler. **Several Rex windows were
  not tested**: which window `session.select` drives, and whether `open -b` fronts that one.

**Recommendation**: `open -b com.superlogical.rex` after `session.select`, and no AppleScript
rung. If several Rex windows turn out to matter, add the AeroSpace title match before it.
None of it needs an Automation grant, so the TCC analysis of
[#11](https://github.com/sigma/sd-herdr/issues/11) and
[#14](https://github.com/sigma/sd-herdr/issues/14) does not apply to the Rex backend.

## 4. Failure modes

| Situation | Result |
| --- | --- |
| Block closed between snapshot and press | `session.focus_block` fails `not_found` (documented, and the same code `program_status` returned for a closed block) |
| No app connected | no `kind: app` client; skip step 2, `open -b` launches or fronts Rex (not tested) |
| App reconnecting, or 16 requests queued for it | `client.perform` fails `client_unavailable` (documented) |
| App does not answer | `timeout` after `timeout_ms` (default 10 s; pass something short) (documented) |
