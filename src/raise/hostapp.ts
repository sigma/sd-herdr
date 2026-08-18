/**
 * Which application hosts the session — the discovery rung 2 needs before it
 * can ask anyone to raise anything.
 *
 * **Rung-2-only machinery, off the hot path.** On a machine with a window
 * manager the ladder never gets here, so none of this runs and no Apple Event
 * is ever sent. It exists for the machine that has no window manager, where the
 * plugin has to name a terminal application before it can script it.
 *
 * Three steps, each measured in `docs/research/terminal-window-discovery.md`:
 *
 * 1. `lsof -U -F pcdn` → the pids connected to the session's client socket.
 *    Peer-pid-of-our-own-connection is a dead end: both herdr sockets are
 *    *listened on by the server*, so asking for our peer returns the daemon,
 *    whose ancestry says nothing about any terminal. The connected client is
 *    found by correlating socket devices instead.
 * 2. `ps` → walk the ppid chain to the ancestor with `ppid == 1`. Termination
 *    is the ppid, never a path shape: a Nix-packaged WezTerm keeps its binary
 *    directly inside `WezTerm.app/` rather than under `Contents/MacOS/`, and
 *    this repo's own toolchain is Nix.
 * 3. `System Events` → that pid's bundle identifier, or nothing when it is not
 *    a GUI application at all (a tmux server, an `sshd`). Querying
 *    `application process` by `unix id` is process metadata rather than
 *    UI-element access, so it needs no Accessibility grant.
 */

/** What discovery found, and — the part the user is owed — how. */
export interface HostApp {
  readonly bundleId: string;
  /**
   * `discovered` is the walk above; `setting` is the `hostAppBundleId` the user
   * configured. The two are kept apart because a silent permanent fallback is
   * how a broken walk goes unnoticed for months.
   */
  readonly source: "discovered" | "setting";
}

/** Everything discovery needs from the world, so a test can supply all of it. */
export interface Discovery {
  /** `lsof -U -F pcdn`, or null if it could not be run. */
  unixSockets(): Promise<string | null>;
  /** `ps -axo pid=,ppid=`, or null if it could not be run. */
  processTree(): Promise<string | null>;
  /** That pid's bundle id, or null when it is not a GUI application. */
  bundleIdOf(pid: number): Promise<string | null>;
  log(message: string): void;
}

/**
 * The pids holding the *client* end of a connection to `socketPath`.
 *
 * `lsof -F` is a field-per-line record format — `p` pid, `c` command, `f` fd,
 * `d` device, `n` name — with each record inheriting the last `p` seen. A
 * connected unix socket renders its peer as `->0x<device>`, so the server's
 * accepted ends are the rows *named* with the socket path, and the clients are
 * the rows pointing at those ends' devices.
 *
 * Rows on the server's own pids are excluded: the server holds both ends of
 * nothing, but it does hold the listening socket alongside the accepted ones,
 * and a daemon is never the answer to "which terminal is this".
 */
export function clientPids(lsof: string, socketPath: string): number[] {
  const servers = new Set<number>();
  const accepted = new Set<string>();
  const peers: { pid: number; device: string }[] = [];

  let pid: number | null = null;
  let device: string | null = null;
  for (const line of lsof.split("\n")) {
    const field = line[0];
    const value = line.slice(1);
    // `f` opens a new file record and `p` a new process set, and a record that
    // carries no `d` must not inherit the previous one's device — that would
    // attribute a connection to a socket that never had one.
    if (field === "p") {
      pid = Number.parseInt(value, 10);
      device = null;
    } else if (field === "f") {
      device = null;
    } else if (field === "d") {
      device = value;
    } else if (field === "n" && pid !== null && device !== null) {
      if (value === socketPath) {
        servers.add(pid);
        accepted.add(device);
      } else if (value.startsWith("->")) {
        peers.push({ pid, device: value.slice(2) });
      }
    }
  }

  const found = peers
    .filter((peer) => accepted.has(peer.device) && !servers.has(peer.pid))
    .map((peer) => peer.pid);
  return [...new Set(found)];
}

/**
 * The pid → ppid map from `ps -axo pid=,ppid=`. Two integers a line, which is
 * why the columns are asked for bare: nothing here has to survive a command
 * line with spaces in it.
 */
export function processTree(ps: string): Map<number, number> {
  const tree = new Map<number, number>();
  for (const line of ps.split("\n")) {
    const [first, second] = line.split(" ").filter((field) => field.length > 0);
    if (first === undefined || second === undefined) continue;
    const pid = Number(first);
    const ppid = Number(second);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) tree.set(pid, ppid);
  }
  return tree;
}

/**
 * Walk to the ancestor whose parent is `launchd`. Null when the chain leaves
 * the map or loops — a pid that died mid-walk, or a table read while the
 * process it names was being reparented.
 */
export function topAncestor(tree: ReadonlyMap<number, number>, pid: number): number | null {
  const seen = new Set<number>();
  let current = pid;
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const parent = tree.get(current);
    if (parent === undefined) return null;
    if (parent <= 1) return current;
    current = parent;
  }
}

/**
 * Name the application hosting the session, preferring the walk and falling
 * back to the configured bundle id.
 *
 * Every failure here is a fall-through rather than a throw: the fallback exists
 * precisely for the cases the walk cannot cover — a client inside tmux or
 * zellij, whose chain terminates at a daemonised multiplexer, or over SSH,
 * whose chain terminates at `sshd`.
 */
export async function discoverHostApp(
  clientSocketPath: string,
  configured: string | undefined,
  discovery: Discovery,
): Promise<HostApp | null> {
  const bundleId = await walk(clientSocketPath, discovery);
  if (bundleId !== null) return { bundleId, source: "discovered" };
  if (configured === undefined || configured.length === 0) {
    discovery.log(
      "raise: cannot name the terminal hosting this session, and no hostAppBundleId is set",
    );
    return null;
  }
  return { bundleId: configured, source: "setting" };
}

async function walk(clientSocketPath: string, discovery: Discovery): Promise<string | null> {
  const lsof = await discovery.unixSockets();
  if (lsof === null) return null;
  const pids = clientPids(lsof, clientSocketPath);
  if (pids.length === 0) {
    // A session with no attached client has no window to raise. The nonce will
    // not have been written either — herdr answers `no_foreground_client` — so
    // the ladder is about to decline anyway.
    discovery.log(`raise: nothing is connected to ${clientSocketPath}`);
    return null;
  }
  if (pids.length > 1) {
    discovery.log(`raise: ${pids.length} clients on ${clientSocketPath}; walking the first`);
  }

  const ps = await discovery.processTree();
  if (ps === null) return null;
  const tree = processTree(ps);

  // Several clients means an ambiguity herdr's own foreground notion would
  // settle, and the nonce already encodes that answer: only the foreground
  // client's window carries it. So each candidate is walked, and the ladder
  // above decides by matching the title.
  for (const pid of pids) {
    const top = topAncestor(tree, pid);
    if (top === null) continue;
    const bundleId = await discovery.bundleIdOf(top);
    if (bundleId !== null) return bundleId;
    discovery.log(`raise: pid ${top} is not a GUI application, so it hosts no window`);
  }
  return null;
}
