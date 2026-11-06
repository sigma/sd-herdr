/**
 * Where the Rex server's control socket lives.
 *
 * A **path convention**, as for herdr's (`src/herdr/session.ts`): the server
 * listens on `~/Library/Application Support/rex/server.sock`
 * (`docs/research/rex-control-api.md`, section 7). `REX_SERVER`, which Rex's own
 * terminals carry, is not in a Stream Deck plugin's environment, so the home
 * directory is the only input, and it is passed in rather than read here. There
 * is one local server, so the path needs nothing else.
 */
import { join } from "node:path";

export function rexSocketPath(home: string): string {
  return join(home, "Library", "Application Support", "rex", "server.sock");
}
