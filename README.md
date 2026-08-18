# sd-herdr

A Stream Deck button that surfaces whether any agent in a
[herdr](https://github.com/ogulcancelik/herdr) session needs attention, and on press takes
you to the most urgent one.

The design is specified in [#17](https://github.com/sigma/sd-herdr/issues/17); the
vocabulary it is argued in is [`CONTEXT.md`](CONTEXT.md).

**Status: it watches, and it can be pressed.** The tile follows the `default` herdr
session — red while any agent is blocked, green when only `done` agents are waiting, amber
when the rest are still working, dark when nothing is, and **grey whenever it cannot see
the session**: an unreachable socket, a stopped session, a snapshot older than 3 s, or an attention set of nothing but `unknown`.
Grey is one state with one plate (`herdr`) however it was reached, and it is never
all-clear. Failures back off to a 5 s ceiling and recover on their own.

A press takes you to the longest-waiting agent: it focuses that pane — workspace, tab and
pane in one call, so the agent is immediately typeable — and raises the host terminal
window through AeroSpace. There is **no cycle yet**: every press goes to the top of the
priority order, so a second `blocked` agent is not yet reachable by button (that is
[#23](https://github.com/sigma/sd-herdr/issues/23)). Pressing while grey raises the window
and focuses nothing, deliberately: the tile has already said it does not trust its data.

Two accepted consequences worth knowing about now:

- **A second `done` agent in the same tab is unreachable by button.** Focusing any pane
  clears herdr's `seen` for *every* pane in that tab, so one press consumes them all. The
  face gives no warning, because there is nothing the user could do differently.
- **A dying client can strand the nonce.** The press writes a marker into herdr's
  `client_window_title` so the raise can find the right window, and clears it immediately
  after. If the client dies in between, `clear` answers `no_foreground_client` and the
  marker stays in the title bar — which is why it reads `sd-herdr raise <session> #<n>`
  rather than a hex blob. Clear it by restarting the herdr client.

Still missing: the settling window after a herdr restart, the press cycle, and the body
line naming where the next press goes.

## Development

Everything runs inside the Nix devShell, which also puts `node_modules/.bin` on `PATH`
(so `streamdeck`, `rollup`, `biome` and `vitest` are plain commands):

```sh
direnv allow          # or: nix develop 'path:.'
just install
```

`just` alone lists the recipes. The gate is `just ci` — `lint`, `typecheck`, `test`,
`build` — which is exactly what `.github/workflows/ci.yml` runs. `just lint` is biome in
**check** mode, so it fails on unformatted sources rather than rewriting them; `just fmt`
is the one recipe that writes.

To install the plugin into the Stream Deck app:

```sh
just link             # builds, then `streamdeck link` the .sdPlugin
```

Then drag **herdr → Attention** onto a key. `just dev` watches and hot-reloads; `just
logs` tails the plugin log.

## Layout

```
src/core/        the seam: reduce(state, event) -> {state, effects} and face(state)
src/face/        the FaceDescriptor and its SVG renderer (pure, unit-tested)
src/herdr/       the NDJSON socket client, and where a session's socket lives
src/raise/       rung 1 of the raise ladder: AeroSpace, probed by absolute path
src/actions/     the Stream Deck action — the only SDK-coupled code
src/testing/     test-only access to the fixture corpus
src/plugin.ts    the entry point
fixtures/        captured and hand-derived herdr snapshots, each with its provenance
dev.yrh.sd-herdr.sdPlugin/   the manifest and images; bin/ is built, not committed
```

All policy lives in `src/core/`, and it is pure: it never reads a clock (every event
carries its own timestamp) and never calls anything (effects come back as data for the
runner to obey). That is what lets a test assert a one-second poll cadence without
sleeping, and it is the seam every later ticket builds against.

The plugin's marketplace icon must be a PNG (the manifest validator rejects an SVG for
that one field). `imgs/plugin/marketplace{,@2x}.png` are rasterized from the checked-in
`marketplace.svg` with `resvg`, at 288×288 and 576×576.

## Manual verification

The edge — the Stream Deck SDK binding and the socket client — holds no policy and is
deliberately not tested in CI. It is verified by hand instead.
Verified on Stream Deck app 7.4.2 / macOS 26.5.2:

- `just validate` — manifest and bundle pass `streamdeck validate`.
- `just link` — the plugin links, and against a connected Stream Deck XL the plugin
  process starts and completes SDK registration (`just logs` shows the
  `RegistrationParameters` handshake).
- The five state colours (`red`, `green`, `amber`, `dark`, `grey`) rasterize as expected
  at 72×72 — checked by rendering the SVGs offline, *not* on the device.
- The computed socket path for `default` matches what a live `herdr session list --json`
  reports, and the plugin connects to it from inside the Stream Deck process — with no
  `herdr` binary involved, which matters because `herdr` is *not* on a plugin's `PATH`
  ([why](docs/research/plugin-runtime-environment.md)).
- A `session.snapshot` round trip over the socket takes ~110 ms against a live 7-agent
  session.
- **The tracer bullet, end to end** (2026-08-17, herdr 0.8.0 / protocol 19): with the
  button on a key, `pane.report_agent` marked one pane `blocked` at `20:16:57.445` and
  the plugin painted red at `20:16:58.082` — **637 ms**. `pane.release_agent` at
  `20:17:00.603` and it painted dark again at `20:17:01.405` — **802 ms**. Both are the
  next poll, so the worst case is a full poll interval plus the ~110 ms round trip. The
  painted descriptor is in `just logs` at debug level, which is how this was timed.
- First paint after a plugin restart: grey at `20:16:54.641`, dark at `20:16:54.749` —
  **108 ms** to a face backed by real data, since there is nothing to resolve first.

- The AeroSpace rung's listing format is what the parser expects:
  `aerospace list-windows --monitor all --format '%{window-id} %{window-title}'` prints one
  `<id> <title>` line per window, ids carry no spaces, and an untitled window still emits
  its trailing separator. Checked against AeroSpace 0.21.3-Beta over 13 live windows.

**Not yet done by hand:** placing the key on the device and confirming the painted face
with human eyes; and one real press end to end — writing the nonce, focusing a pane and
raising its window — which mutates a live herdr session, so it wants a scratch session
rather than the one you are working in.
