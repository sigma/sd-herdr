# How a Node client speaks the Rex control API

Research for [sigma/sd-mux#30](https://github.com/sigma/sd-mux/issues/30) (map:
[#29](https://github.com/sigma/sd-mux/issues/29)).

**Subject**: Rex server `0.0.1793890641-gaf0c20` (commit `af0c204`), API revision `11`
(server speaks 0–11), Rex Beta app `0.1.0 (1829)`, macOS, Node `v24.18.0`, `ws@8.21.3`.

## Evidence key

- **[V]** — verified against the live server, from Node. Probes were read-only against
  existing sessions; writes went only to a throwaway session (`sdmux-probe`) created for
  the purpose.
- **[D]** — from the server's own API documentation, which it serves at `GET /llms.txt`
  and builds from its own API, so it matches the running version. Saved nowhere in this
  repo: fetch it again from the socket rather than trust a copy.

## 1. Transport

- **[V]** The socket is an **HTTP server**, not a raw JSON stream: a bare JSON line gets
  `HTTP/1.1 400 Bad Request`. Over a Unix socket any host name works in the URL.
- **[D]** Endpoints: `GET /api/control` (the control WebSocket), `GET /api/data` (one
  WebSocket per block's output stream), `GET /api/help` (every method's JSON Schema),
  `GET /llms.txt` / `GET /llms.html` (the documentation).
- **[V]** The control connection is a WebSocket with subprotocol **`rex.control.v1`**.
  From Node 20+, `ws` connects over the Unix socket with a `createConnection` option:

  ```js
  import { createConnection } from "node:net";
  import WebSocket from "ws";
  const ws = new WebSocket("ws://localhost/api/control", "rex.control.v1", {
    createConnection: () => createConnection(socketPath),
  });
  ```

  `ws` is already in the dependency tree, at `8.21.3`, as a dependency of
  `@elgato/streamdeck`, so a direct dependency on it adds no code to the bundle.
  Node 20 (the plugin manifest's runtime) has no stable built-in WebSocket client.

- **[D]** Every message, both directions, is one JSON object in one text frame. The server
  sends `welcome` (once), `response`, and `event`; the client sends one `hello`, then only
  `request`. Unknown `type`s must be skipped.

## 2. Handshake and version pinning

- **[V]** Within 5 s of opening, send a hello; the server answers with a welcome:

  ```json
  {"type":"hello","api_revision":11,"api_min_revision":11,"client":{"kind":"other","name":"sd-mux","version":"…"}}
  ```
  ```json
  {"type":"welcome","protocol":"rex.control.v1","api_revision":11,"api_server_revision":11,"limits":{"max_message_bytes":1048576}}
  ```

- **[D]** The server negotiates the newest revision both sides speak and **translates older
  revisions' shapes**, so an older client keeps working against a newer server. A client
  and server sharing no revision get close status **1008** with a reason naming which side
  to update.
- **Recommendation**: send `api_revision: 11` *and* `api_min_revision: 11`. The plugin then
  only ever receives the shapes it was written against; a server older than 11 refuses the
  connection (1008), which the tile renders as grey. Because the server translates
  downwards, the plugin does not need to bump in lockstep with Rex releases — only when it
  wants a newer field.
- **[D]** No authentication over the Unix socket beyond the file's mode (`srw-------`, owner
  only) **[V]**. The hello may carry a `reconnect_token` to resume a client (see §6).

## 3. Requests, attach, and the snapshot

- **[D]** `{"type":"request","id":"<string>","method":"…","payload":{…}}`; the response
  carries the same `id`, a `seq`, and either `payload` or `error {code, message, status}`.
  Responses can arrive out of order, except for a listed set of ordered methods (all the
  focus and layout mutations among them). A reused in-flight `id` closes the connection.
- **[V]** A connection must be **attached** before naming a session: `session.view` on an
  unattached connection fails with `conflict`. `session.attach_all` attaches to every
  session at once and is enough for `session.view` and for block methods.
- **[V]** A block method is called by its full name with `session_id`, `block_id`, and
  `args`, e.g. `com.superlogical.terminal.program_status`. (The CLI's `block.method`
  wrapper is a separate, equivalent method.)
- **[V]** Shape of `session.view` that the plugin reads:

  ```
  { revision, session_id, label, active_window_id,
    windows: [ { window_id, label, focused_block_id,
                 layers: [ { layer_id, kind: "tiled" | …, bounds,
                             layout: { rect: [x, y, w, h], block_id | split… },
                             blocks: [ { block_id, label, creator_name, flavor, owner } ] } ] } ] }
  ```

  Blocks live under `windows[].layers[].blocks` — **there is no top-level `blocks`**.
  `layout.rect` is normalised `[x, y, w, h]` in `0..1`, which supplies the pane index's
  `(y, x)` sort the way herdr's `layouts[]` does. Detached blocks are absent from the view
  (`session.list_blocks` lists them); a detached block cannot be shown, so the attention
  set should ignore it.
- **[V]** Cost of one full poll — `session.list`, `session.view` per session, and
  `program_status` per terminal block, issued concurrently per session — on 4 sessions /
  4 terminal blocks: **~1.2–1.7 ms and ~3.9 KB**, over one already-open connection. herdr's
  `session.snapshot` cost ~110 ms / 15 KB per call ([#2](https://github.com/sigma/sd-mux/issues/2)).
  Polling every second is therefore free; the cost scales with one call per terminal block.

## 4. Program status

- **[V]** `com.superlogical.terminal.program_status` returns `{records: [...]}`; each record
  carries `state`, `updated_at` (RFC 3339, server clock), optional `id` (absent = root),
  `app`, `effective_app`, `kind`, `progress`, `title`, `msg`, `owner {pid, name}`. Claude
  Code reports on the root record as `app: "claude-code"`.
- The reporting side is the [Program Status Protocol (OSC 7501)](https://www.superlogical.com/rex/docs/build/program-status.md).
  Lifecycle questions — what clears `done` — belong to [#31](https://github.com/sigma/sd-mux/issues/31).

## 5. Push vs poll

- **[V]** Status changes **are pushed**, as a `block_event` named `program_status_changed`
  inside a `session_event`, carrying the **whole new record** (it replaces the old one) and
  a `reason`. Captured from the throwaway session:

  ```json
  {"id":"","record":{"state":"blocked","kind":"question","app":"probe","effective_app":"probe",
   "updated_at":"2026-11-06T21:37:53.240115+01:00","owner":{"pid":40429,"name":"fish"}},"reason":"report"}
  ```

  Removals arrive as `program_status_removed {ids, reason}`, with `reason ∈ clear |
  child_exited | reset | prompt | foreground | evicted` **[D]**.
- **[V]** ⚠️ They arrive **only** with `session.attach_all {event_scope: "all"}` (or a
  per-session `session.attach`). With `event_scope: "session"` the same three reports
  produced no `block_event` at all — that scope excludes `block_event` by design **[D]**.
  Scope `all` also delivers client churn (`client_joined`, `client_connected`, …): ~20
  events while the CLI ran a handful of commands, to be skipped.
- **[D]** Unlike herdr's subscriptions, the event stream is **gap-free**: `seq` starts at 1
  and goes up by one; each response carries the `seq` of the last event already reflected
  in it; and the server *closes* the connection (1008 `event backlog exceeded`, past 8 MiB)
  rather than skip one. Every reason [#7](https://github.com/sigma/sd-mux/issues/7) gave
  for dropping herdr subscriptions — per-pane only, silently mute on pane death, no way to
  tell a missed event — is absent here.
- **Recommendation**: keep the 1 s poll for v1. It costs ~1 ms, it reuses the existing
  `runner`/staleness machinery unchanged, and the core needs a full snapshot each tick
  anyway. Push is a sound later optimisation (lower latency to the face), not a
  correctness need. If adopted, apply events on top of a `session.view` by `seq` as the
  docs describe.

## 6. Connection lifetime

- **[D]** One long-lived connection, unlike herdr's one-request-per-connection. The server
  pings every 120 s and closes with 1001 `keepalive timeout` after 3 unanswered pings; `ws`
  answers pings automatically. Pinging the server on the same schedule lets the client
  notice a dead server. The plugin's 3 s **staleness deadline** already covers a wedged
  connection without that.
- **[D]** A connection that drops *without* a close frame keeps its client for 60 s, and a
  hello carrying the last `reconnect_token` resumes it. The plugin keeps no server-side
  state worth resuming, so it can always start a new client; it must close with a close
  frame on shutdown so the server does not hold a ghost client for 60 s.

## 7. Finding the socket from the plugin

- **[V]** `rex server status` and `servers/<hash>/runtime.json` both give the endpoint as
  `unix://$HOME/Library/Application%20Support/rex/server.sock`. `REX_SERVER` carries it
  only inside Rex terminals, and the Stream Deck plugin's environment does not include it.
  `HOME` *is* there ([plugin environment research](plugin-runtime-environment.md)), so the
  path is derived from `os.homedir()` the same way `src/herdr/session.ts` derives herdr's.
- The path contains a space; pass it to `net.createConnection` as a plain path, not
  through a `ws+unix:` URL.
- Not checked: a non-default server location (the docs mention an `--extra-listen` flag
  and remote hosts, both out of scope per the map), or a second local Rex version running
  its own server.

## 8. Failure modes

| Situation | What the client sees |
| --- | --- |
| No server (socket file absent) | `ENOENT` on connect **[V]** |
| No common API revision | close 1008, reason names the side to update **[D]** |
| Block closed between view and call | `error {code: "not_found", status: 404, message: "block not found: …"}` **[V]** |
| Session destroyed | `error {code: "session_not_found", status: 404}` **[V]** |
| Session named before attaching | `error {code: "conflict"}` **[V]** |
| Client fell 8 MiB of events behind | close 1008 `event backlog exceeded` **[D]** |
| Server restart | not measured here; [#32](https://github.com/sigma/sd-mux/issues/32) |

Every one of these maps to grey. None needs a new state.

## 9. What this means for the backend seam

- The herdr client's "connect → one request → close" shape does not carry over; the Rex
  client holds one connection and reconnects with the existing backoff on close.
- `HerdrError(code, message)` has a direct Rex counterpart in `error.code`, which is
  stable and documented — branch on it, never on `message`.
- **[V]** `session.attach_all` covers sessions created after it. On a throwaway server, a
  connection that had sent it with no sessions present could `session.list`, `session.view` and
  poll two sessions that a second connection created afterwards (2026-11-07). A tile that
  watches the whole server relies on this.
- **[V]** Every id observed carries a UUIDv7 under a kind prefix (`session:01a1…`,
  `window:01a1…`, `block:01a1…`), so ids from different sessions do not collide.
- `server.status.instance_id` (`afc3ce9e-…`, alongside `started_at` and `pid`) is a
  candidate server-lifetime marker, to be confirmed in
  [#32](https://github.com/sigma/sd-mux/issues/32).
