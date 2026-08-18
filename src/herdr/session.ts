/**
 * Where a herdr session's socket lives.
 *
 * This is a **path convention, not a lookup**. herdr derives every session's
 * socket from its config directory (`src/session.rs: api_socket_path_for`):
 *
 * ```
 * default        <configDir>/herdr.sock
 * named <name>   <configDir>/sessions/<name>/herdr.sock
 * ```
 *
 * so the plugin can compute it rather than ask. That is worth doing rather than
 * shelling out to `herdr session list --json`, for four reasons:
 *
 * 1. **No subprocess, and so no binary to find.** `herdr` is not on a Stream
 *    Deck plugin's PATH (measured in `docs/research/plugin-runtime-environment.md`),
 *    which would otherwise force an absolute-path probe and a login-shell
 *    fallback — a whole discovery mechanism in service of one string.
 * 2. **No CLI in the way.** The `herdr` CLI enforces a protocol match and
 *    refuses to run against an older server: an installed CLI ahead of the
 *    running one already breaks `herdr api snapshot` on this machine. The
 *    socket has no version negotiation, so speaking to it directly sidesteps a
 *    failure mode the CLI would have imported.
 * 3. **`running` is better answered by connecting.** The listing reports it;
 *    the connection *is* it. The plugin opens the socket a moment later anyway,
 *    and `ENOENT` / `ECONNREFUSED` is the same "cannot see the session" the
 *    listing would have spelled out more slowly.
 * 4. **It is pure**, so it is tested rather than hand-verified.
 *
 * The cost is a coupling to herdr's on-disk layout. It is a cheap one: the
 * failure mode is a socket that nothing answers, which is a state the plugin
 * already renders honestly.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * herdr's placeholder session, which lives directly in the config directory.
 *
 * Exported because it is one concept with three readers: the path convention
 * below, the button's unconfigured default, and the nameplate — which spends
 * the slot on product identity rather than repeating herdr's placeholder back
 * at the user. A literal in three files would let them drift apart.
 */
export const DEFAULT_SESSION = "default";

/**
 * herdr's config directory: `$XDG_CONFIG_HOME/herdr`, else `~/.config/herdr`
 * (`src/config/io.rs: config_dir`).
 *
 * ⚠️ A Stream Deck plugin's environment holds fifteen variables and
 * `XDG_CONFIG_HOME` is not among them, so in practice this takes the home
 * branch even for a user whose shell sets it. Shelling out would not have
 * helped: a subprocess inherits the plugin's environment, so `herdr session
 * list` would read exactly the same variables.
 */
function configDir(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = env.XDG_CONFIG_HOME;
  return xdg !== undefined && xdg.length > 0 ? join(xdg, "herdr") : join(home, ".config/herdr");
}

/**
 * The socket path for a session name. Total — every name yields a path, and
 * whether anything is listening on it is the socket client's question.
 */
export function socketPathFor(
  sessionName: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return sessionSocket(sessionName, "herdr.sock", env, home);
}

/**
 * The *other* socket in the same directory: the one the server listens on for
 * its TUI clients (`herdr-client.sock`, verified beside `herdr.sock` on a live
 * install).
 *
 * The plugin never speaks this protocol. It needs the path only as a name to
 * correlate against in `lsof` output, which is how the raise ladder finds the
 * process — and so the terminal application — hosting the session.
 */
export function clientSocketPathFor(
  sessionName: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return sessionSocket(sessionName, "herdr-client.sock", env, home);
}

function sessionSocket(
  sessionName: string,
  file: string,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  const dir = configDir(env, home);
  return sessionName === DEFAULT_SESSION
    ? join(dir, file)
    : join(dir, "sessions", sessionName, file);
}
