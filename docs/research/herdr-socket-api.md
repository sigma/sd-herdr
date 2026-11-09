# How a Node client speaks the herdr socket API

Research for [sigma/sd-mux#2](https://github.com/sigma/sd-mux/issues/2) (map: #1).

**Subject**: herdr `0.8.0`, protocol `19`, macOS (darwin 25.5.0), Node `v26.7.0`.

## Evidence key

Every claim below is tagged:

- **[V]** — VERIFIED empirically against the live server at `~/.config/herdr/herdr.sock`
  (read-only probes only: `ping`, `session.snapshot`, `pane.get`, `events.subscribe`).
- **[S]** — INFERRED from the herdr Rust source at
  `/Users/yann/src/github.com/ogulcancelik/herdr` (checked out at
  `preview-2026-08-04-…-120-gb2924877`, i.e. *ahead of* the installed 0.8.0 —
  treat source-only claims as strong but not conclusive).
- **[D]** — from the bundled JSON schema (`herdr api schema --json`) or herdr's own
  prose docs (`docs/next/website/src/content/docs/socket-api.mdx`).
- **[U]** — UNVERIFIED. Would require a mutating call or a scratch session.
  Not run: the probe target was the user's live working session.

Source references are to the herdr checkout, not to this repo.

---

## 1. Transport, framing, handshake, auth

**Framing: newline-delimited JSON (NDJSON), UTF-8, one JSON value per `\n`-terminated
line, in both directions.** [V][S][D]

- Server writes with `write_text_line` → `write_all(bytes)` + `write_all(b"\n")` +
  `flush()` (`src/api/server.rs`). [S]
- herdr's own docs say so explicitly: "Herdr uses newline-delimited JSON over a local
  socket… Send one request per line." [D]
- Verified: a raw `net.createConnection(sock)` + `write(JSON.stringify(req) + "\n")`
  yields exactly one `\n`-terminated JSON line back. [V]

**There is no handshake, no version negotiation, and no authentication.** [V][S]

- The server reads the *first* line off a fresh connection and dispatches it directly
  (`handle_connection_with_stop` → `read_initial_request_line`). No preamble is
  expected or sent. [V][S]
- Authorisation is filesystem-only: the socket is created mode `0600`
  (`SOCKET_PERMISSION_MODE: u32 = 0o600`), so "can open the file" == "is authorised".
  [S] Confirmed on disk: `srw------- yann staff … herdr.sock`. [V]
- Version discovery is a normal request, not a handshake — `ping` returns the server
  version, protocol number and capability flags. Verified response:

  ```json
  {"id":"p1","result":{"type":"pong","version":"0.8.0","protocol":19,
   "capabilities":{"live_handoff":true,"detached_server_daemon":true}}}
  ```
  [V]

**Limits and timeouts** (all [S], from `src/api/server.rs` constants):

| Constant | Value | Meaning |
|---|---|---|
| `INITIAL_REQUEST_TIMEOUT` | 5 s | server hangs up if the first line isn't complete in 5 s |
| `MAX_INITIAL_REQUEST_BYTES` | 1 MiB | oversized request line → connection error |
| `STREAM_WRITE_TIMEOUT` | 5 s | server-side write timeout |
| `CONNECTION_POLL_INTERVAL` | 100 ms | subscription poll tick — the event delivery quantum |

### 1a. ⚠️ One request per connection

**This is the single most important structural fact, and it is not obvious from the
schema.** [V][S]

The server reads **exactly one** request line per connection, answers it, and closes
the socket. It never loops back to read a second request.

Verified: writing two `ping` requests down one connection (200 ms apart) produced
**one** response, and the server then sent FIN:

```
pipeline closed, responses: 1
  {"id":"a","result":{"type":"pong",…}}     ← id "b" never answered
```
[V]

Consequences for the plugin:

- Every snapshot, every `agent.focus`, every `ping` is **its own connect → write →
  read one line → server FIN → close** cycle. Measured round trip for
  `session.snapshot` (15 KB result): **~110 ms**, of which ~100 ms is the server's
  poll quantum. [V]
- The only *long-lived* connections are the streaming methods: `events.subscribe`,
  `pane.graphics.stream`, and the blocking waiters (`events.wait`, `agent.wait`,
  `agent.prompt` with `wait`, `pane.wait_for_output`). [S][D]
- So "the plugin holds one long-lived connection" is only true of the **subscription**
  connection. Snapshots and focus are short-lived side connections.

### 1b. ⚠️ Never write anything on a subscription connection

The subscription loop calls `should_stop_connection` → `probe_stream_closed` each
tick, and that helper treats **any readable byte** as "peer is gone":

```rust
let status = match stream.read(&mut probe) {
    Ok(0) => Ok(true),   // EOF
    Ok(_) => Ok(true),   // ANY inbound byte ⇒ tear down
    …
};
```
(`src/ipc.rs`) [S]

Verified: sending `session.snapshot` down an active subscription socket produced no
response and an immediate server FIN — the subscription died. [V]

**Rule: after `events.subscribe`, the client socket is strictly read-only.** Do not
send keepalives, pings, or anything else. To stop, just `destroy()` the socket.

### 1c. Malformed input

| Input | Response | Tag |
|---|---|---|
| `not json\n` | `{"id":"","error":{"code":"invalid_request","message":"invalid request: expected ident at line 1 column 2"}}` | [V] |
| unknown `method` | `{"id":"","error":{"code":"invalid_request","message":"invalid request: unknown variant `no.such.method`, expected one of …"}}` (~1.8 KB listing all 90 methods) | [V] |
| `params` omitted | `{"id":"","error":{"code":"invalid_request","message":"invalid request: missing field `params` …"}}` | [V] |

Note: on a parse failure the `id` echoed back is **`""`**, not the client's id — the
request never got that far. `params` is **required even when empty**: send
`"params": {}`. [V]

---

## 2. Snapshot

**Request** (`herdr api snapshot` is a thin wrapper): [V]

```json
{"id":"snap-1","method":"session.snapshot","params":{}}
```

**Response**: `{"id":…,"result":{"type":"session_snapshot","snapshot":{…}}}`.
(`herdr api snapshot` on the CLI prints the whole envelope, not just the snapshot.) [V]

Snapshot top-level keys, verified live: [V]

```
version ("0.8.0"), protocol (19),
workspaces[], tabs[], panes[], layouts[], agents[],
focused_workspace_id, focused_tab_id, focused_pane_id
```

`agents[]` is **already filtered to panes that host an agent** — in the live session,
15 `panes[]` but 7 `agents[]`; the 8 non-agent panes carry `agent: null` and
`agent_status: "unknown"`. [V] This means the plugin's attention model can read
`snapshot.agents` directly and does **not** need the "`unknown` *with* an `agent`
field" filter from map #1 as a pane-level guard — though keeping the guard is
harmless and defensive.

A verified `agents[]` entry:

```json
{"agent":"claude","agent_status":"idle","cwd":"…/IaC","focused":false,
 "foreground_cwd":"…/IaC","pane_id":"wX:p1","revision":28,"state_change_seq":591,
 "tab_id":"wX:t1","terminal_id":"term_658d53b0bbf791",
 "terminal_title":"✳ Claude Code","terminal_title_stripped":"Claude Code",
 "workspace_id":"wX"}
```
[V] Schema adds optional `name`, `title`, `display_agent`, `state_labels`,
`agent_session`, `tokens`, `interactive_ready`, `launch_pending`. [D]

**Can it share a connection with an active subscription? No.** [V] Two independent
reasons: one-request-per-connection (§1a), and writing on the subscription socket
kills the subscription (§1b). **The snapshot must go on its own short-lived
connection.** This is fine and cheap (~110 ms).

**`state_change_seq`** is a session-wide monotonic counter
(`next_agent_state_change_seq += 1` in `src/app/actions.rs`), so "lowest seq =
longest-waiting" from map #1 holds. [S] Caveat: it starts at 0 on server start and
is not restored from `session.json`, so ordering is only meaningful **within one
server lifetime** — another reason to re-snapshot after reconnect. [S]

---

## 3. Subscriptions

**Request**:

```json
{"id":"sub-1","method":"events.subscribe",
 "params":{"subscriptions":[ …one or more Subscription objects… ]}}
```

**Ack**: `{"id":"sub-1","result":{"type":"subscription_started"}}` — no subscription
handle, no id, no per-subscription addressing. [V] The connection *is* the
subscription. To unsubscribe, close the socket.

Multiple heterogeneous subscriptions can share **one** `events.subscribe` call and
therefore one connection. [V][D]

### 3a. ⚠️ `pane.agent_status_changed` is per-pane, not global

The `Subscription` variant requires a `pane_id`:

```json
{"type":"pane.agent_status_changed","pane_id":"wX:p1","agent_status":"blocked"}
```
(`agent_status` is an optional filter.) `required: ["type","pane_id"]`. [D][S]

**There is no global "any pane's agent status changed" subscription.** The
`SubscriptionEventKind` enum has only three members:
`pane.output_matched`, `pane.agent_status_changed`, `pane.scroll_changed` — all
pane-scoped. [D] Every other subscribable type (`workspace.*`, `tab.*`,
`pane.created|closed|updated|focused|moved|exited|agent_detected`, `worktree.*`,
`layout.updated`) is global and delivered as a *different* envelope (§3c). [D][S]

So `PaneAgentStatusChangedEvent` alone is **not** sufficient to keep an attention set
current: **you can only subscribe to panes you already know about.** A pane that
appears after you subscribed will never produce a status event on your existing
connection.

### 3b. Minimum viable subscription set

To keep an attention set current you need **two categories** on the same connection:

1. **Per-pane status** — one `{"type":"pane.agent_status_changed","pane_id":X}` entry
   for every `pane_id` in `snapshot.agents`. This is the actual attention signal.
2. **Global membership** — at minimum:
   - `{"type":"pane.agent_detected"}` — an agent appeared in, or was released from, a
     pane. Carries `pane_id`, `workspace_id`, `agent`, and on release
     `released: true` + `final_status`. [V]
   - `{"type":"pane.closed"}` and `{"type":"pane.exited"}` — the pane went away. [V]
   - `{"type":"pane.created"}` — optional; `pane.agent_detected` usually follows for
     agent panes and is the more precise trigger. [V]

   These do not update statuses; they tell you **the pane set changed**, which means
   *your per-pane subscription list is now stale.* The correct reaction is:
   **tear down the subscription connection, re-snapshot, and re-subscribe with the new
   pane list.** There is no way to add a subscription to a live connection. [S]

`pane.updated` is **not** a usable status proxy: `emit_pane_updated` is called for
terminal-title changes, agent renames and a few runtime paths, not on status
transitions, and herdr's docs note spinner-only title changes are suppressed.
[S][D] It is also extremely chatty. Don't use it.

### 3c. ⚠️ Two different envelope shapes arrive on the same stream

Verified on one connection: [V]

```jsonc
// (a) per-pane subscription event — dotted kind, no "type" inside data
{"event":"pane.agent_status_changed",
 "data":{"agent":"claude","agent_status":"idle","pane_id":"wZ:p1","workspace_id":"wZ"}}

// (b) global lifecycle event — underscored kind, "type" discriminator INSIDE data
{"event":"pane_agent_detected",
 "data":{"type":"pane_agent_detected","agent":"claude","pane_id":"w0:p1","workspace_id":"w0"}}
```

Note the naming skew: `pane.agent_status_changed` (dots) vs `pane_agent_detected`
(underscores). A Node dispatcher must handle both spellings.

`PaneAgentStatusChangedEvent` fields: `pane_id`, `workspace_id`, `agent_status`
(required); `agent`, `title`, `display_agent`, `state_labels` (optional). [D]
Note it does **not** carry `state_change_seq` — the press-priority tiebreak from
map #1 is only available from a snapshot. Another argument for the post-focus
re-fetch already decided in #1.

### 3d. ⚠️ Global subscriptions replay the event backlog on subscribe

The `EventHub` is a ring buffer of the **last 512 events** since server start, and a
newly-created *global* subscription starts at `last_sequence: 0` — i.e. it replays
everything still in the buffer before reaching live events. [S]

Verified: two identical `{"type":"pane.agent_detected"}` subscriptions opened 8 s
apart each replayed the **same five historical events**, including a
`released: true` event for a pane that had already gone. [V]

Worse, delivery is throttled: `ActiveEventSubscription::poll` returns **at most one
matching event per 100 ms tick per subscription** [S], verified as events arriving at
exactly ~100 ms spacing. [V] So a kind with 300 buffered events takes ~30 s to drain
before the client sees anything live.

**Implications for the plugin:**

- Never treat early lifecycle events as current state. Snapshot is the only truth.
- Prefer **narrow, low-traffic** global subscriptions (`pane.agent_detected`,
  `pane.closed`, `pane.exited`). Subscribing to `pane.updated` or `layout.updated`
  would bury you in replay.
- Per-pane `pane.agent_status_changed` subscriptions do **not** replay — they
  initialise `last_sequence` to `event_hub.current_sequence()`. [S] Verified: a
  7-pane status subscription emitted nothing for 45 s of a quiet session, then a
  genuine live event at +36.5 s on a longer run. [V]

### 3e. Subscription setup errors

If any subscription in the array fails to initialise, the server writes **one error
line and closes the connection** — no `subscription_started`, and no partial
subscription. [V][S]

Verified with a nonexistent pane:

```json
{"id":"bad:sub:0:probe","error":{"code":"pane_not_found","message":"pane wZZ:p9 not found"}}
```

⚠️ **The `id` is not the request id.** It is `"<request_id>:sub:<index>:probe"` —
an internal probe id. A Node client correlating strictly on `id` will not match this.
Correlate the first line by position, or by `id.startsWith(requestId)`. [V]

This is a live hazard: a pane can close between your snapshot and your subscribe, and
the whole subscription then fails. Retry with a fresh snapshot.

### 3f. Cost note

When the event hub is quiet, each per-pane `pane.agent_status_changed` subscription
falls through to an internal `pane.get` dispatch into the app **every 100 ms**. [S]
With N agent panes that is 10·N app round-trips per second. In the observed session
(7 agents) this was not visibly harmful, but it argues against subscribing to panes
you don't care about.

---

## 4. Focus

### 4a. `agent.focus`

```json
{"id":"focus-1","method":"agent.focus","params":{"target":"wX:p1"}}
```

`params` is `AgentTarget { target: string }` — a single free-form string. [D]
Response is `{"type":"agent_info","agent":{…AgentInfo…}}`. [D][S]

**What `<target>` accepts** (`resolve_agent_target`, `src/app/terminal_targets.rs`): [S]

1. A **public pane id** (`"wX:p1"`) — accepted only if that pane currently hosts an
   agent (`target_is_agent`).
2. An **agent name** (the user-assigned `agent.rename` name, i.e. `AgentInfo.name`) —
   accepted only if it matches exactly one agent; otherwise
   `agent_target_ambiguous`.

It does **not** accept `terminal_id`, workspace id, or tab id. [S]
`herdr agent focus --help` documents only a bare positional `<target>` with no
further text. [V]

### 4b. ⚠️ One request switches workspace AND tab AND pane

`handle_agent_focus` → `focus_agent_target` → `State::focus_pane_in_workspace(ws_idx,
pane_id)` (`src/app/actions.rs`), which:

```rust
let tab_idx = ws.find_tab_index_for_pane(pane_id)?;   // locate the tab
…
self.switch_workspace_tab(ws_idx, tab_idx);           // ← workspace + tab
tab.layout.focus_pane(pane_id);                       // ← pane
```
[S]

**So a single `agent.focus` is sufficient.** The plugin does **not** need to chain
`workspace.focus` → `tab.focus` → `pane.focus`. [S] — **[U] not executed**; this is
the one contract derived purely from source, per the read-only constraint.

Corroborating: the same helper backs `pane.focus`, and the server log shows the UI
emitting paired `workspace.focus` + `tab.focus` entries when focus crosses a
workspace, i.e. one API call fans out into both. [V, from
`~/.config/herdr/herdr-server.log`]

`focus_pane_in_workspace` early-returns `false` when the target is already focused,
but `handle_agent_focus` still returns a success `agent_info`. So **re-focusing the
already-focused agent is a successful no-op**, not an error — which is exactly what
map #1's "with exactly one blocked agent, re-press re-focuses it" needs. [S]

### 4c. `pane.focus` as an alternative

```json
{"id":"focus-1","method":"pane.focus","params":{"pane_id":"wX:p1"}}
```

Same `focus_pane_in_workspace` core, returns `pane_info`, and — unlike `agent.focus`
— does **not** require the pane to host an agent. [S] Given the plugin already has
`pane_id` from the snapshot, `pane.focus` is arguably the tighter contract:
unambiguous, no name resolution, no `agent_target_ambiguous` failure mode.

Note `herdr pane focus` on the CLI is *directional* (`pane.focus_direction`), not
`pane.focus` by id — the CLI is not a guide here. [V]

### 4d. What focus does *not* do

herdr is a TUI; `agent.focus` moves focus **inside** herdr's own client. It does not
raise the host terminal's OS window — herdr cannot even tell which application hosts
its client (already settled in map #1). macOS window activation stays the plugin's
job.

---

## 5. Failure modes

### 5a. Request naming a pane that has since closed

| Call | Response | Tag |
|---|---|---|
| `pane.get` with `"wZZ:p99"` | `{"id":"p6","error":{"code":"pane_not_found","message":"pane wZZ:p99 not found"}}` | [V] |
| `pane.get` with `"garbage"` | `{"id":"p7","error":{"code":"pane_not_found","message":"pane garbage not found"}}` | [V] |
| `pane.focus` with a dead pane | `pane_not_found` (`handle_pane_focus` returns `pane_not_found` on both the id-parse and find-tab failure paths) | [S][U] |
| `agent.focus` with a dead pane / unknown name | `{"code":"agent_not_found","message":"agent target <t> not found"}` | [S][U] |
| `agent.focus` with an ambiguous name | `{"code":"agent_target_ambiguous", …}` listing candidates | [S][U] |
| `events.subscribe` naming a dead pane | `pane_not_found` under id `<req>:sub:<i>:probe`, then connection close (§3e) | [V] |

Note the error is *soft*: normal error response, normal connection close, no crash.
**Malformed ids and dead ids are indistinguishable** — both are `pane_not_found`. [V]

**Silent-death case worth calling out**: if a pane dies while a per-pane
`pane.agent_status_changed` subscription is watching it, the subscription's internal
`pane_get` starts failing and `poll()` swallows the error (`.ok().flatten()`). The
subscription simply **goes quiet forever** — no error line, no close, no notification.
[S] This is precisely why the plugin also needs the global `pane.closed` /
`pane.exited` / `pane.agent_detected` subscriptions, and why a periodic snapshot
sweep is a cheap safety net.

### 5b. Server disappearing mid-subscription

- **On shutdown** the server sets `running = false`, the subscription loop's
  `should_stop_connection` returns `true`, the stream is dropped (FIN), and
  `ServerHandle::drop` unlinks the socket file if it owns it. [S]
- **Client observable**: a clean EOF. Node emits `'end'` then `'close'` with **no
  `'error'`**. Verified by proxy — the identical teardown path (triggered in §1b)
  produced exactly `end` → `close`, no error. [V for the observable; [S] for shutdown
  being the same path; [U] for an actual `server.stop`, which is forbidden here.]
- ⚠️ A clean EOF on a subscription socket is **indistinguishable from a normal
  close**. Node's `'close'` handler gets `hadError === false` either way. Treat *any*
  unexpected `close` on the subscription socket as "connection lost" → grey face →
  reconnect. Never render it as "all clear".
- **On reconnect**, two distinct errors are possible and both must be handled: [V]
  - socket file absent (server stopped and cleaned up) → `ENOENT`
  - socket file present but no listener (crash / stale file) → `ECONNREFUSED`
    (verified with an orphaned unix socket file: errno 61).

    herdr itself treats a stale-socket `ECONNREFUSED` as "safe to unlink and rebind"
    on next start (`prepare_socket_path`, `src/ipc.rs`) [S] — so the plugin should
    treat both errors identically: session not visible, retry with backoff.
- **Version skew after an update**: `ping` carries `version` and `protocol`. Since
  herdr updates underneath a long-lived plugin (map #1), re-`ping` on every reconnect
  and refuse/grey out on `protocol !== 19` rather than misparsing. [V for the fields'
  availability]

---

## 6. Minimal Node client

Verified end-to-end apart from the marked `focus` call, which is written but **not
executed** (the probe target was a live session).

```js
import net from 'node:net';

const SOCK = `${process.env.HOME}/.config/herdr/herdr.sock`;

/** Read `\n`-delimited JSON off a socket. */
function onJsonLines(sock, cb) {
  let buf = '';
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) cb(JSON.parse(line));
    }
  });
}

/**
 * One request == one connection. The server answers a single line and hangs up.
 * Resolves with the parsed envelope (success OR error); rejects on transport failure.
 */
function request(method, params = {}, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = `sd-herdr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sock = net.createConnection(SOCK);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('herdr timeout')); }, timeoutMs);
    let settled = false;
    onJsonLines(sock, (msg) => {
      settled = true; clearTimeout(timer); sock.destroy(); resolve(msg);
    });
    sock.on('connect', () => sock.write(`${JSON.stringify({ id, method, params })}\n`));
    // ENOENT = no session; ECONNREFUSED = stale socket file. Both mean "can't see it".
    sock.on('error', (err) => { clearTimeout(timer); reject(err); });
    sock.on('close', () => {
      if (!settled) { clearTimeout(timer); reject(new Error('herdr closed without responding')); }
    });
  });
}

const unwrap = (env) => {
  if (env.error) throw Object.assign(new Error(env.error.message), { code: env.error.code });
  return env.result;
};

// --- snapshot -------------------------------------------------------------
const snapshot = async () => unwrap(await request('session.snapshot')).snapshot;

// --- subscription ---------------------------------------------------------
/**
 * Long-lived, READ-ONLY connection. Writing anything after events.subscribe
 * makes the server tear the subscription down.
 *
 * `paneIds` come from a fresh snapshot; when a membership event fires the caller
 * must close() and re-subscribe — subscriptions cannot be edited in place.
 */
function subscribe(paneIds, { onStatus, onMembership, onClosed, onError }) {
  const id = `sd-herdr-sub-${Date.now()}`;
  const sock = net.createConnection(SOCK);
  let started = false;

  onJsonLines(sock, (msg) => {
    if (!started) {
      // First line is the ack — or an error whose id is "<id>:sub:<n>:probe", not `id`.
      started = true;
      if (msg.error) { onError?.(msg.error); sock.destroy(); }
      return;                            // {"result":{"type":"subscription_started"}}
    }
    switch (msg.event) {
      case 'pane.agent_status_changed':  // dotted: per-pane subscription event
        onStatus?.(msg.data);            // {pane_id, workspace_id, agent_status, agent?, title?}
        break;
      case 'pane_agent_detected':        // underscored: global lifecycle event
      case 'pane_created':
      case 'pane_closed':
      case 'pane_exited':
        onMembership?.(msg.event, msg.data);
        break;
      default:
        break;
    }
  });

  sock.on('connect', () => sock.write(`${JSON.stringify({
    id,
    method: 'events.subscribe',
    params: {
      subscriptions: [
        ...paneIds.map((pane_id) => ({ type: 'pane.agent_status_changed', pane_id })),
        { type: 'pane.agent_detected' },
        { type: 'pane.closed' },
        { type: 'pane.exited' },
      ],
    },
  })}\n`));

  sock.on('error', (err) => onError?.(err));
  // A clean EOF looks identical to a normal close: always treat it as "lost".
  sock.on('close', () => onClosed?.());

  return { close: () => sock.destroy() };
}

// --- focus (WRITTEN BUT NOT EXECUTED in this research) --------------------
/** One call switches workspace + tab + pane. Errors: agent_not_found / agent_target_ambiguous. */
const focusAgent = async (target) => unwrap(await request('agent.focus', { target }));
/** Same effect, keyed strictly on pane id; error: pane_not_found. Preferred. */
const focusPane  = async (pane_id) => unwrap(await request('pane.focus', { pane_id }));

// --- wiring ---------------------------------------------------------------
const snap = await snapshot();
console.log(snap.protocol, snap.version, snap.agents.map((a) => `${a.pane_id}=${a.agent_status}`));

const sub = subscribe(snap.agents.map((a) => a.pane_id), {
  onStatus: (e) => console.log('status', e.pane_id, e.agent_status),
  onMembership: async () => { sub.close(); /* re-snapshot + re-subscribe */ },
  onClosed: () => console.log('connection lost — grey face, reconnect with backoff'),
  onError: (e) => console.log('sub error', e),
});

// await focusPane(snap.agents[0].pane_id);   // NOT RUN
// then immediately re-snapshot (map #1: focusing a blocked agent emits no event)
```

⚠️ **Verified gotcha in exactly this snippet**: because global subscriptions replay
the backlog (§3d), `onMembership` fires within ~100 ms of every subscribe, on stale
history. A naive "membership event ⇒ close and re-subscribe" loop therefore
**thrashes forever**. [V] Real implementations must either (a) debounce the
re-subscribe (e.g. 500 ms–1 s) *and* compare the new snapshot's pane-id set against
the current one, only re-subscribing when it actually differs, or (b) ignore
membership events for the first second after `subscription_started`. Option (a) is
strictly better because it also collapses bursts.

---

## 7. Consequences for the sd-herdr spec

1. **The client is not one connection, it is one subscription connection plus
   short-lived request connections.** Correct #2's framing of "one long-lived
   connection".
2. **The subscription must be rebuilt whenever the agent-pane set changes.** There is
   no incremental subscribe. Membership events are a trigger to
   `close → snapshot → re-subscribe`, not a state update. This makes the reconnect
   loop and the "membership change" path the *same* code path — a simplification.
3. **`PaneAgentStatusChangedEvent` alone is insufficient** — it is per-pane, so new
   agents are invisible to an existing subscription. Answer to the ticket's explicit
   question: pane/agent lifecycle events **are** required.
4. **A single `agent.focus`/`pane.focus` handles workspace + tab + pane.** No chaining.
   Prefer `pane.focus` (unambiguous, keyed on the id you already hold).
5. **Snapshot polling as a safety net is cheap** (~110 ms, ~15 KB) and covers the two
   silent-failure modes: a per-pane subscription going mute after its pane dies, and
   event-backlog replay lag.
6. **Grey face triggers**: `ENOENT`, `ECONNREFUSED`, subscription `close`, request
   timeout, and `ping.protocol !== 19`.
7. **Re-subscribe must be debounced and set-compared**, or event replay turns the
   membership path into a hot loop (see the warning under §6).

## 8. Open / unverified

- **[U] `agent.focus` / `pane.focus` cross-workspace behaviour was not executed.**
  It is derived from `focus_pane_in_workspace` in the source. Needs a scratch herdr
  session to confirm empirically that one call lands on a pane in a non-active tab of
  a non-active workspace.
- **[U] `agent.focus` by agent *name*** — resolution and the `agent_target_ambiguous`
  shape are source-only.
- **[U] `server.stop` mid-subscription** — the client-side observable (`end` → `close`,
  no error) was confirmed via an identical teardown path, not via an actual shutdown.
- **[U] Whether focusing a `done` agent flips it to `idle`** (map #1's self-consuming
  tier) — mutating; not tested here.
- **[U] Behaviour across a herdr live-handoff / self-update** (`capabilities.live_handoff:
  true`) — does the socket survive, or does the client see a close and need to
  reconnect? Untested.
- The herdr source checkout is *ahead* of the installed 0.8.0. All [S] claims were
  cross-checked against 0.8.0's own bundled schema and live behaviour where possible,
  but the focus internals are from the newer tree.
