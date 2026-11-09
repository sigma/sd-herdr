# Can the plugin see which session the Rex app is displaying?

Research for [sigma/sd-mux#34](https://github.com/sigma/sd-mux/issues/34) (map:
[#29](https://github.com/sigma/sd-mux/issues/29)).

**Subject**: Rex server `0.0.1793890641-gaf0c20` (API revision 11), Rex Beta app
`0.1.0 (1829)` with one app window. The app was switched between sessions with
`client.perform` → `session.select` while a listener with `event_scope: "all"` recorded every
event.

## 1. Answer: not through the API

No field, event or action reports the session an app is showing. **[D]** = from the
server's API documentation (`/llms.txt`), **[V]** = verified.

| Candidate | What it actually tracks |
| --- | --- |
| `client.inspect` / `client_changed` → `session_ids` | sessions the app has **attached** to. **[V]** It grew from 2 to 3 when the app was shown a new session and did not shrink when the app moved on. "Ever shown", not "shown now". |
| `block_owner_changed` → `owner` = the app | **[V]** The app claimed the blocks of a session when it showed it (`request`/`take`), and released nothing in the session it left. Ownership is also "ever shown". |
| `session.view` → `active_window_id` | the server's own active window, which the app does not follow ([rex-raise.md](rex-raise.md) §1) **[V]** |
| client actions | `session.select`, `session.switch`, … all *do* things; none answers a query **[D]** |

## 2. The one signal that does work is outside the API

The Rex window's title is `<tab label> - <session label>` for what it displays, and AeroSpace
reports it (`aerospace list-windows --all --format '%{window-title}'`). It changed within a
second of each switch. It is not usable as the default:

- it needs AeroSpace, or an Accessibility grant to read window titles, for a feature that is
  supposed to need no setup;
- it yields a **label**, and labels are neither unique nor stable (§3);
- with several Rex windows there is no single displayed session.

## 3. ⚠️ Session labels change on their own

**[V]** On the user's server, a session created as `sdmux-cc` was relabelled `sd-herdr`
(the name of its working directory) within the same 0.1 s, by a `session_label_changed`
event nobody asked for. The same happened to every throwaway session in this research. On
an isolated server with an empty config and no app attached it did not happen, and the
user's `init.lua` sets no labels. So it is the Rex app's automatic session naming, which a
user may or may not have on.

So a tile configured by **label** can stop matching when Rex renames the session, and two
sessions can carry the same label (two checkouts of one repo). `session_id` never changes
and is never reused **[D]**, and survives a server restart ([rex-server-restart.md](rex-server-restart.md)).

## 4. Consequence for the map

The decision "an unconfigured Rex tile follows the session the app is displaying" **cannot
be implemented** and falls back as the map provided: **a Rex tile needs its session
configured.** The storage key should be the `session_id`, not the label. The property
inspector would then list the live sessions by label and store the id. That replaces
herdr's typed session name, which is a spec question; the map decides it.
