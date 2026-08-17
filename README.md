# sd-herdr

A Stream Deck button that surfaces whether any agent in a
[herdr](https://github.com/ogulcancelik/herdr) session needs attention, and on press takes
you to the most urgent one.

The design is specified in [#17](https://github.com/sigma/sd-herdr/issues/17); the
vocabulary it is argued in is [`CONTEXT.md`](CONTEXT.md).

**Status: tracer bullet.** The tile watches the `default` herdr session and turns red
while any agent in it is blocked, amber when only `done` agents are waiting, and dark when
nothing is. It cannot yet be pressed and does not name where a press would go. Grey is
only half-implemented: it covers "no snapshot yet" and an `unknown`-only attention set,
but not the staleness deadline or the settling window — so a face currently outlives the
session it describes rather than aging out of it.

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
- The four state colours (`red`, `amber`, `dark`, `grey`) rasterize as expected at 72×72
  — checked by rendering the SVGs offline, *not* on the device.
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

**Not yet done by hand:** placing the key on the device and confirming the painted face
with human eyes. That is a physical step, not scriptable; do it after `just link`.
