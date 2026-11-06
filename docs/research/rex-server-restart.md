# What survives a Rex server restart

Research for [sigma/sd-herdr#32](https://github.com/sigma/sd-herdr/issues/32) (map:
[#29](https://github.com/sigma/sd-herdr/issues/29)).

**Subject**: Rex server `0.0.1793890641-gaf0c20`, API revision 11. Measured on an
**isolated server**, never the user's:

```sh
rex server run --listen unix:///tmp/sdmux-rex/s.sock \
  --state-dir /tmp/sdmux-rex/state --config /tmp/sdmux-rex/init.lua   # empty config
```

One session, one window, two terminal blocks: *A* holding a root `done@probe` record at the
prompt, *B* holding `working@probe` from a foreground `sleep 600`. Each boundary was
crossed, then the server was started again on the same `--state-dir` and the state read
back over the control API. Both shapes were tried: `rex server stop` (clean) and `SIGKILL`
(crash).

The isolated server still created `servers/<endpoint-hash>/start.lock` under
`~/Library/Application Support/rex/`, despite `--state-dir`. Delete it after a test like this.

## 1. Results

| | Clean stop | `SIGKILL` |
| --- | --- | --- |
| Socket file while down | removed (`ENOENT`) | left behind (`ECONNREFUSED`) |
| Terminal processes | **killed** | **killed** |
| Back up after restart | ~80 ms | ~80 ms |
| `session_id`, `window_id`, `block_id` | **unchanged** | **unchanged** |
| Labels | unchanged | unchanged |
| What runs in each block | a fresh `login` shell | a fresh `login` shell |
| Program-status records | **all gone**, `done` included | **all gone** |
| `server.status.instance_id` | **new** | **new** |
| `started_at`, `pid` | new | new |

The terminal processes are children of the server (`rex` → `login` → shell → agent, read
from the user's own server's process tree), which is why they cannot outlive it. The binary
shows no process-handoff mechanism, only an inherited *listener*. The Rex app's **Restart
Server…** action and app updates were not exercised, because they would restart the user's
server; nothing found suggests they behave differently.

## 2. Compared with herdr

herdr has two boundary shapes ([#9](https://github.com/sigma/sd-herdr/issues/9),
[#13](https://github.com/sigma/sd-herdr/issues/13)): a **stop/restart** kills the agents
and nothing comes back, and a **live handoff** keeps them and re-detects them over ~3.7 s,
which is why the tile holds grey for 4 s on a `terminal_id` change
([#26](https://github.com/sigma/sd-herdr/issues/26)).

Rex has only the first shape. Nothing repopulates after a restart, because the agent
processes are dead and Rex keeps no record of them. **A dark tile after a Rex restart is
honest**, and there is no repopulation window to hold grey through.

## 3. What this means for the backend

- **Lifetime marker: `server.status.instance_id`.** It changes on every start and is free
  to read. Not `terminal_id`-style: block ids survive the restart, so the herdr rule ("a
  changed id under a stable id") has nothing to compare. The welcome message does not
  carry the instance id, so the client reads `server.status` after each connect.
- **A restart always drops the control connection first.** The plugin learns about it from
  the close and the reconnect, never from a poll answered by the new server. So the marker
  is checked on reconnect, not per poll.
- **No settling window for Rex.** The neutral `Snapshot`'s lifetime marker can stay optional
  as the map proposes: a Rex restart is a reset (clear the visited set, as herdr's detected
  restart does) and nothing else. The 3 s staleness deadline already covers the gap while
  the server is down (~80 ms here, longer under a real app restart).
- **`done` does not survive a restart.** An agent finished and unseen before a restart is
  gone afterwards, process and record. That is the same loss herdr has, but on Rex it is
  the only shape there is. It needs no handling, but the README should state it.
