# sd-herdr

A Stream Deck button that surfaces whether any agent in a
[herdr](https://github.com/ogulcancelik/herdr) session needs attention, and on press takes
you to the most urgent one.

The design is specified in [#17](https://github.com/sigma/sd-herdr/issues/17); the
vocabulary it is argued in is [`CONTEXT.md`](CONTEXT.md).

**Status: skeleton.** The plugin installs, runs, and paints one key with a *static* face.
There is no herdr client and no attention policy yet — the tile's colour, plate and body
are hard-coded.

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
src/face/        the FaceDescriptor and its SVG renderer (pure, unit-tested)
src/actions/     the Stream Deck action — the only SDK-coupled code
src/plugin.ts    the entry point
dev.yrh.sd-herdr.sdPlugin/   the manifest and images; bin/ is built, not committed
```

The plugin's marketplace icon must be a PNG (the manifest validator rejects an SVG for
that one field). `imgs/plugin/marketplace{,@2x}.png` are rasterized from the checked-in
`marketplace.svg` with `resvg`, at 288×288 and 576×576.

## Manual verification

The edge — the Stream Deck SDK binding, and later the socket client and subprocess runner
— holds no policy and is deliberately not tested in CI. It is verified by hand instead.
Verified on Stream Deck app 7.4.2 / macOS 26.5.2:

- `just validate` — manifest and bundle pass `streamdeck validate`.
- `just link` — the plugin links, and against a connected Stream Deck XL the plugin
  process starts and completes SDK registration (`just logs` shows the
  `RegistrationParameters` handshake).
- The four state colours (`red`, `amber`, `dark`, `grey`) rasterize as expected at 72×72
  — checked by rendering the SVGs offline, *not* on the device.

**Not yet done by hand:** placing the key on the device and confirming the painted face.
That is a physical step, not scriptable; do it after `just link`.
