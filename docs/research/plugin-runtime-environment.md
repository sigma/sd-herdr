# What a Stream Deck plugin process can actually do

Research for [sigma/sd-herdr#19](https://github.com/sigma/sd-herdr/issues/19) (spec: #17).

**Subject**: Elgato Stream Deck `7.4.2.22730` on macOS `26.5.2` (darwin 25.5.0), bundled
Node `v20.20.0`, plugin `dev.yrh.sd-herdr` `0.1.0.0` linked from the repo checkout.
Measured 2026-08-17.

## Method

Every number below was read **from inside the running plugin process**, not from a
shell. A throwaway `src/probe.ts` was built into the plugin with `just build`, loaded by
`just restart`, and dumped its findings to `/tmp`; the jj change carrying it was
abandoned afterwards. Attribution facts were read from `tccd`'s own log
(`log show --predicate 'process == "tccd"' --info --debug`), which prints the identity
it adjudicated against.

Everything here is **[M]** — measured — unless tagged otherwise. `[U]` marks something
still unverified.

All five assumptions the spec rests on **held**. Nothing in #17 needed correcting; one
*consequence* of §1 was missing from it, and is called out in §7.

---

## 1. PATH: not inherited. The plugin gets launchd's, not the user's

The plugin process's entire environment: [M]

```
PATH=/usr/bin:/bin:/usr/sbin:/sbin
HOME, LOGNAME, SHELL, SSH_AUTH_SOCK, TMPDIR, USER, XPC_FLAGS, XPC_SERVICE_NAME,
OSLogRateLimit, QTWEBENGINE_CHROMIUM_FLAGS, QTWEBENGINE_REMOTE_DEBUGGING,
QT_MEDIA_BACKEND, QT_WIDGETS_RHI, __CF_USER_TEXT_ENCODING
```

Fifteen variables, and `PATH` is the bare launchd default. **The spec's assumption
holds**: rung 1's absolute-path probe is necessary, not redundant.

`SHELL` *is* present (`/run/current-system/sw/bin/fish`) — but it is the passwd-entry
value carried down by launchd, not evidence that any profile was sourced. Nothing from
the user's shell configuration reaches the process.

The gap is not academic on this machine. A login shell reports:

```
/Users/yann/.cargo/bin:…/.nix-profile/bin:/etc/profiles/per-user/yann/bin:
/run/current-system/sw/bin:/nix/var/nix/profiles/default/bin:/usr/local/bin:…
```

— nine directories the plugin cannot see. [M]

Other process facts worth recording: `cwd` is the `.sdPlugin` directory (not the repo
root, and not `/`); `ppid` is the Stream Deck app itself; `uid` is the logged-in user.
[M]

## 2. Subprocesses: unrestricted

Every spawn attempted succeeded — `/bin/echo`, `/bin/ps`, `/usr/bin/log`,
`/usr/bin/osascript`, and `/usr/bin/env sh -lc …`. No sandbox denial, no entitlement
error, no seatbelt log entry. [M]

Two consequences beyond "the raise ladder can work":

- **A login shell is a usable PATH-recovery mechanism.** `sh -lc 'command -v herdr'`
  runs and returns the user's real PATH — so "probe an absolute path" and "ask a login
  shell" are both available, and the second finds binaries the first would have to
  guess at.
- The 5 s / 1 MiB limits in the herdr socket protocol, not process limits, remain the
  binding constraints on the plugin's I/O.

## 3. Responsible process: `com.elgato.StreamDeck`, confirmed twice

The spec assumed it; it is now measured, at two independent layers.

**In `tccd`'s adjudication**, for an `osascript` spawned by the plugin: [M]

```
<TCCDProcess: identifier=com.apple.osascript, pid=60306> …
Derived team id of <private> for TCCDProcess: identifier=com.elgato.StreamDeck, pid=982,
  auid=502, euid=502,
  responsible_path=/Applications/Elgato Stream Deck.app/Contents/MacOS/Stream Deck,
  binary_path=/Applications/Elgato Stream Deck.app/Contents/MacOS/Stream Deck
…
AUTHREQ_SUBJECT: msgID=60306.1, subject=com.elgato.StreamDeck
```

The accessing process is `osascript`; the *subject* — whose grant is consulted and
whose row is written — is `com.elgato.StreamDeck`. Neither `node` nor the plugin's own
bundle id appears anywhere in the chain.

**In the user-visible prompt**, which named the same app: [M]

```
Prompting for access to indirect object TextEdit by Elgato Stream Deck
```

And the row created on the user's answer was bundle-scoped to Stream Deck: [M]

```
Publishing <TCCDEvent: type=Create, service=kTCCServiceAppleEvents,
  identifier_type=Bundle ID, identifier=com.elgato.StreamDeck>
```

**So tier 2 spends Stream Deck's Automation grant, not its own.** Three things follow:

- The grant is **shared with every other Stream Deck plugin**, and so is the *denial*.
  A user who denies Stream Deck once — for any plugin — denies it for sd-herdr too.
- The plugin cannot scope, name, or reset its own grant. `tccutil reset AppleEvents` is
  bundle-scoped, so the smallest reset available to a user is "all of Stream Deck's
  Automation grants".
- The prompt the user sees says **Elgato Stream Deck**, not sd-herdr. Onboarding copy
  (deferred in #17) has to name the app the dialog names, or it will not match what is
  on screen.

## 4. Native addons: enabled on 7.x

`--no-addons` is **not** passed. The plugin's full `execArgv` is: [M]

```
--no-global-search-paths  --enable-source-maps  --inspect=127.0.0.1:<port>
```

(`--inspect` is present because the plugin was linked from a dev checkout.)

Confirmed positively rather than by absence, by handing `process.dlopen` a file that is
a valid Mach-O but not an addon: [M]

```
/bin/echo → ERR_DLOPEN_FAILED: "Module did not self-register: '/bin/echo'."
```

That is the *post-load* failure. A build with addons disabled fails earlier and
differently ("Cannot load native addon because loading addons is disabled"), so
reaching self-registration proves `dlopen` ran. **Native addons load.**

Bundled runtime, for the record: Node `20.20.0`, V8 `11.3.244.8-node.33`, N-API `9`,
modules ABI `115`, OpenSSL `3.0.17`. The runtime lives under
`~/Library/Application Support/com.elgato.StreamDeck/NodeJS/20.20.0/node` — a
*versioned* directory, so an addon pinned to ABI 115 is pinned to a path Elgato can
move out from under it.

Only relevant if the deferred helper-binary option is revived; recorded so that
decision starts from a fact.

## 5. `osascript` on an Automation denial

Produced against a live denial: the plugin asked `TextEdit` for a real Apple event, the
user answered **Don't Allow** on the resulting prompt, and the call was re-run. [M]

| | |
|---|---|
| exit status | `1` |
| stdout | empty |
| stderr | `31:46: execution error: Not authorized to send Apple events to TextEdit. (-1743)\n` |
| signal | none |

Four details #8 has to build against:

1. **The `NN:NN:` prefix is a character range into the script source, and it moves.**
   The same denial through `tell application id "com.apple.TextEdit"` printed
   `44:59:` instead of `31:46:`. Any parser anchored to a fixed prefix breaks the
   moment the script text changes. [M]
2. **The code is in the message, in parentheses, at the end**: `(-1743)`. It is not on
   a separate line, not in a field, and not the exit status. Match `(-1743)` — or
   `/\((-\d+)\)\s*$/` and compare numerically — exactly as #17 line 205 requires.
3. **The target app's name is interpolated** ("… to TextEdit."), so the message text is
   not a constant. Another reason not to match on prose.
4. **The denial is sticky and silent.** The second invocation produced the identical
   error with **no** prompt. This confirms the spec's "macOS never re-prompts": the
   plugin gets one shot, and after a denial the only recovery is the user visiting
   System Settings.

**Not a TCC failure, and a trap for the naive probe**: `tell application "TextEdit" to
get name` succeeds with **no** grant and **no** prompt, because AppleScript answers
`name` locally from the app bundle without sending an event. Any liveness probe built
on `get name` will report success on a fully denied system. Use an event that actually
crosses the process boundary (`count documents`, a window query). [M] — this cost one
probe round to discover.

## 6. TCC state created by this probe

Recorded here because #19 requires it, and because the state was **deliberately left in
place** (owner's call, 2026-08-17) rather than reset:

| Client | Target | Result |
|---|---|---|
| `com.elgato.StreamDeck` | Finder | allowed |
| `com.elgato.StreamDeck` | System Events | allowed |
| `com.elgato.StreamDeck` | TextEdit | **denied** |

The reset was declined because it cannot be scoped: `tccutil reset AppleEvents
com.elgato.StreamDeck` would also drop whatever Automation grants Stream Deck's other
plugins hold, and there is no per-target reset. The three rows above are visible and
individually revocable under **System Settings → Privacy & Security → Automation →
Elgato Stream Deck**.

The TextEdit **deny** row is the one that matters for later work: it is inert for the
plugin (no rung targets TextEdit) but it is also a **standing fixture** — a reproducible
`-1743` on demand, without another prompt, for testing #8's parser. Do not clear it
without deciding to give that up.

## 7. Consequences for the spec

Nothing in #17 was contradicted. One thing was missing:

1. **The `herdr` binary is not on the plugin's PATH either.** #17 line 203 says the
   *AeroSpace* binary needs an absolute-path probe "because a Stream Deck plugin does
   not inherit the shell PATH" — but the same sentence applies verbatim to `herdr`, and
   the spec does not say so. Measured: `herdr` lives at `/usr/local/bin/herdr`, which
   is outside the plugin's four-entry PATH, and `execFile("herdr", …)` from the plugin
   fails with **`ENOENT`**. [M]

   So **`herdr session list` (#17 line 107, and the resolve step in #20) cannot be
   invoked by bare name.** It needs the same treatment as AeroSpace: an absolute-path
   probe at startup, cached — with `sh -lc 'command -v herdr'` available as a second
   rung, since §2 shows a login shell runs fine and finds it.

2. Everything else stands: PATH is not inherited (§1), subprocesses are unrestricted
   (§2), the responsible process is `com.elgato.StreamDeck` (§3), the bundled Node
   loads addons (§4), and a denial is exit 1 + `(-1743)` on stderr (§5).

## 8. Open / unverified

- **[U] Whether an *installed* (non-dev-linked) plugin gets the same environment.** The
  measured process was `streamdeck link`ed from the repo, which adds `--inspect` and
  `--enable-source-maps` to `execArgv`. PATH and the attribution chain are set by
  launchd and Stream Deck respectively and should not vary, but this was not confirmed
  against a plugin installed from a `.streamDeckPlugin` bundle.
- **[U] Whether Stream Deck's Automation grant survives a Stream Deck update.** The
  grant is keyed on the bundle id plus a code requirement; a re-signed update
  ordinarily keeps it, but this was not exercised.
- **[U] Whether an addon compiled against ABI 115 keeps working across an Elgato Node
  bump.** §4 establishes only that loading is permitted today.
- **[U] The environment on Windows.** Everything here is macOS-only, as is the raise
  ladder it supports.
