import { spawn } from "node:child_process";

import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

const uuid = "dev.yrh.sd-mux";
const sdPlugin = `${uuid}.sdPlugin`;
const isWatching = !!process.env.ROLLUP_WATCH;

/**
 * In watch mode, restart just this plugin in Stream Deck after every rebuild —
 * this is what turns `rollup -w` into a hot-reload loop. `streamdeck` is on PATH
 * because the devShell prepends node_modules/.bin.
 */
const reloadPlugin = {
  name: "streamdeck-reload",
  writeBundle() {
    spawn("streamdeck", ["restart", uuid], { stdio: "inherit", shell: true });
  },
};

/**
 * Bundle the plugin into a single ESM file under the .sdPlugin/bin folder that
 * `manifest.json`'s CodePath points at.
 */
export default {
  input: "src/plugin.ts",
  output: {
    file: `${sdPlugin}/bin/plugin.js`,
    sourcemap: isWatching,
  },
  plugins: [
    typescript({ exclude: ["**/*.test.ts"] }),
    nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
    // The SDK's websocket transport (`ws`) is CommonJS behind an ESM wrapper.
    commonjs(),
    isWatching && reloadPlugin,
  ],
};
