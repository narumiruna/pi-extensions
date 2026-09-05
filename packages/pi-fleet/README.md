# 🚀 Pi Fleet — Launch and Connect Local Pi Sessions

[![npm](https://img.shields.io/npm/v/@narumitw/pi-fleet)](https://www.npmjs.com/package/@narumitw/pi-fleet) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Launch another Pi process in a terminal split without replacing the current session.
You can also connect trusted local Pi sessions for bounded notifications and one-turn requests.
Pi Fleet detects tmux, Zellij, or Ghostty automatically, and you can pin a backend when needed.

## ✨ Features

- Opens a distinct Pi process in tmux, Ghostty, or Zellij while preserving the parent session.
- Inherits the cwd, model, thinking level, and optional first task after launch review.
- Waits for the child to authenticate before reporting that the new session is ready.
- Connects explicitly joined same-user sessions through owner-only local sockets and ephemeral invites.
- Delivers notifications without a model turn and bounds each allowed request to one turn.
- Authenticates and bounds local protocol traffic, peers, retries, rates, deadlines, and diagnostics.
- Cleans all sockets, launchers, tasks, timers, and status on leave, reload, replacement, or shutdown.

## 📦 Install

Install persistently:

```bash
pi install npm:@narumitw/pi-fleet
```

Try the published package without a permanent install:

```bash
pi -e npm:@narumitw/pi-fleet
```

Build and load the extension from a local checkout:

```bash
npm --workspace @narumitw/pi-fleet run build
pi --no-extensions --no-skills --no-session -e ./packages/pi-fleet
```

The package declares `dist/index.ts`, so an unbuilt local checkout must run the build before Pi loads the package directory.
A child started in any supported terminal uses normal Pi extension discovery.
Install Pi Fleet persistently to test split-and-auto-join because the child does not inherit the parent's temporary `-e` argument.

Pi extensions execute with your user permissions.
Review extension source before installing it.

## 🚀 Quick start

Run `/fleet`, choose **New Pi session…**, select a split direction, and optionally enter a first task.
Before creating a split, Pi Fleet asks for the configured launch confirmation.

## 🧭 Launch flow

Use **Settings** to pin a terminal backend or change final launch confirmation.
With the default settings, Pi Fleet detects the current supported terminal.

After any configured launch confirmation, Pi Fleet:

1. Creates or reuses an ephemeral local group.
2. Creates the selected terminal split.
3. Starts a separate named Pi process in the selected cwd.
4. Waits for the child to authenticate and report readiness.
5. Sends the optional first task through a launch-specific one-time kickoff.

If the terminal creates a split but the child does not become ready, Pi Fleet reports a partial launch.
It leaves the visible split open instead of closing a potentially useful pane.

## 🛠️ Tools

### `session_spawn`

Creates a separate Pi process in a terminal split.

| Parameter | Required | Description |
| --- | --- | --- |
| `terminal` | No | Strict `tmux`, `ghostty`, or `zellij` override; omission uses `defaultTerminal`, initially `auto`. |
| `direction` | No | `right`, `down`, `left`, or `up`; defaults to `right`. |
| `task` | No | First task sent only after authenticated readiness. |
| `name` | No | Child session display name. |
| `cwd` | No | Existing directory; defaults to the current cwd. |

The tool supports only TUI and RPC modes because launch may require confirmation.
In JSON and print modes, it fails before creating a group, launcher, or split.
Successful details include `terminal`, `terminalId`, and `terminalVersion`.
Ghostty results also retain `ghosttyVersion` for compatibility.

### `session_bus`

Lists or messages sessions in the active Pi Fleet group.

| Action | Fields | Behavior |
| --- | --- | --- |
| `list` | none | Lists authenticated live peers and request policy. |
| `send` | `targetSessionId`, `message`, optional `mode` | Sends `notify` by default or a permitted one-turn `request`. |
| `reply` | `targetSessionId`, `message`, `replyTo` | Correlates a reply without starting another automatic turn. |

An accepted acknowledgement means the recipient extension accepted or deduplicated the message, not that the remote agent completed the work.
Rejected and busy acknowledgements use stable codes such as `requests_disabled`, `rate_limited`, `target_busy`, and `delivery_failed`.
Rate-limited responses may include a bounded retry delay.
Peer-list text and details share a 40 KiB UTF-8 result budget below Pi's tool-output limit.

## 💬 Commands

| Command | Modes | Description |
| --- | --- | --- |
| `/fleet` | TUI, RPC | Open the state-aware Pi Fleet manager. |
| `/fleet <pifleet:v1:invite>` | TUI, RPC | Review the join confirmation and join one ephemeral local group. |

Unknown and trailing arguments are rejected.
JSON and print command routes fail before opening sockets or custom UI.

The manager keeps **New Pi session…** first whether connected or disconnected.
Its **Settings** screen changes the default terminal and final launch confirmation.
Connected sessions can send a message, inspect peers, copy the explicit invite, change request policy, inspect settings, status, and help, or leave the group.

## 🖥️ Terminal backends

### Automatic built-in default

`defaultTerminal: "auto"` resolves one backend from the Pi process environment for each launch.
It selects the first complete signature in this fixed order:

1. tmux when `TMUX` is non-empty and `TMUX_PANE` is `%` followed by a numeric pane id.
2. Zellij when `ZELLIJ` is non-empty and `ZELLIJ_PANE_ID` is numeric.
3. Ghostty when `TERM_PROGRAM` is exactly `ghostty`.

When nested terminals leave multiple signatures, this fixed order may select an outer multiplexer instead of the visible inner pane.
Pi Fleet does not inspect the process tree.
If no signature matches, Pi Fleet fails before creating a group, launcher, socket, or split and asks the user to enter a supported context or pin a backend.
After resolution, Pi Fleet preflights only the selected adapter.
It does not switch backends after a version, platform, executable, focus, permission, split, child-startup, or kickoff failure.

### tmux

The tmux backend requires:

- tmux 3.2 or newer.
- Pi running inside the target tmux pane with `TMUX` and `TMUX_PANE` available.

Pi Fleet targets the current pane, uses `split-window`, passes the cwd and launch-only environment to the new pane, and maps left or up to a split inserted before the current pane.

### Ghostty

Automatic selection uses Ghostty when no tmux or Zellij signature matched and `TERM_PROGRAM=ghostty`.
Choose Ghostty under **Settings**, or pass `terminal: "ghostty"` to pin or strictly override the configured preference.

Ghostty requires:

- macOS.
- Ghostty 1.3 or newer.
- Pi running in the currently focused Ghostty terminal.
- macOS Automation permission for the process hosting Pi to control Ghostty.

Pi Fleet uses Ghostty's native `split` AppleScript command with positional arguments.
It does not simulate user key presses or depend on customized keybindings.

The first automatically selected or pinned Ghostty launch may trigger a macOS Automation permission prompt during availability checking.
If permission is denied, enable it in **System Settings → Privacy & Security → Automation** and retry.
Pi Fleet does not fall back to another backend after denial.

### Zellij

Automatic selection uses Zellij before Ghostty when its complete pane signature is present.
Choose Zellij under **Settings**, or pass `terminal: "zellij"` to pin or strictly override the configured preference.

Zellij requires:

- Zellij 0.44 or newer.
- Pi running inside the target Zellij pane with `ZELLIJ` and `ZELLIJ_PANE_ID` available.

Pi Fleet uses `zellij action new-pane` with a private self-deleting launcher path and validates the returned `terminal_<id>` pane identity.
Right and down use Zellij's native split directions.
Left and up create the corresponding native pane and then use pane-targeted `move-pane` placement.
A placement failure is a partial launch because the child pane may already be running and remains visible.

## ⚙️ Settings

Open `/fleet` and choose **Settings**.
Pi Fleet stores user settings in `<getAgentDir()>/pi-fleet.json`, normally `~/.pi/agent/pi-fleet.json`:

```json
{
  "defaultTerminal": "auto",
  "confirmSessionLaunch": true
}
```

| Setting | Values | Default | Behavior |
| --- | --- | --- | --- |
| `defaultTerminal` | `auto`, `tmux`, `ghostty`, `zellij` | `auto` | Resolves the current backend automatically or pins one for menu launches and omitted tool values. |
| `confirmSessionLaunch` | `true`, `false` | `true` | Shows or skips the final launch preview for menu and tool launches. |

An explicit `session_spawn.terminal` value strictly overrides `defaultTerminal` for that launch and never accepts `auto`.
Pi Fleet reads standard terminal context variables only for automatic selection and does not treat them as settings overrides.
Pi Fleet does not read project settings or extension-specific environment-variable overrides.
A missing file uses the defaults without creating the file.
Each Settings change saves immediately.
Writes preserve unknown fields, run in order within one Pi process, and publish atomically through a private temporary file and rename.
The Settings screen reports malformed or invalid files and does not overwrite them.
Separate Pi processes do not share a settings lock, so do not edit this file concurrently from multiple sessions.
A Settings change applies immediately in the current process; other running Pi processes reload it on their next session start or `/reload`.

Group secrets, request permission, peers, readiness state, and deduplication state stay in memory except for the short-lived private Zellij launch copy described below.
The `pifleet:v1` prefix versions the bearer-invite encoding separately from the version-2 socket protocol.
Version-2 messages normally expire after two minutes and cannot declare a lifetime longer than five minutes.
Accepted message ids remain deduplicated for ten minutes, longer than their valid delivery window.
A copied invite is still a reusable bearer secret, so discard it or start a new group when you need to rotate access.
A short-lived in-process handoff preserves a group across `/reload` for the same `sessionManager` only.
Membership does not carry into `/new`, `/resume`, or another logical session without a new invite.

The terminal child receives an internal launch-only environment envelope containing a parent-only kickoff capability.
The child consumes and deletes those values during `session_start` before Pi tools can inherit them.
These values are not user settings or supported environment overrides.

Incoming agent requests are blocked by default.
Enabling them permits trusted invite holders to start paid model turns that may edit the same workspace concurrently.

## 🔒 Security and privacy

- Runtime directories are owned by the current user and restricted to `0700`, which is the portable filesystem access boundary.
- Endpoint manifests and Unix sockets are restricted to `0600` as additional platform-specific defense in depth.
- Discovery ignores symlinks, non-regular files, oversized manifests, wrong owners, malformed records, endpoint filename mismatches, and incompatible versions.
- Discovery scans at most 512 directory entries, accepts at most 64 valid manifests, probes at most 16 peers concurrently, and finishes under one overall deadline.
- Invalid manifests do not consume the valid-peer quota, and bounded non-secret diagnostics distinguish saturation, conflicts, protocol failures, deadlines, and unreachable peers.
- Every manifest, request, and response is authenticated for its group and endpoint instance.
  Frames also bind the logical target, claimed sender, clock window, nonce, and request id.
- The shared group MAC proves possession of the bearer invite, not a separate cryptographic identity for each peer.
- A trusted invite holder can claim another session id, so session and endpoint labels are collaboration hints rather than a separate authorization boundary.
- Launch kickoffs also require a random capability shared only through the parent-to-child launch envelope.
  It is not published through peer discovery or persisted with delivered messages.
- Two simultaneously live endpoints claiming one session id are omitted from discovery and rejected as an explicit identity conflict.
- Bearer invites are shown only on the explicit invite screen or direct join input.
- Pi Fleet does not retain invites as durable settings or group state, but a recipient can copy and reuse one until every holder discards it or moves to a new group.
- Invites are not placed in tool output, status, notifications, custom renderers, or model context.
- Tmux receives launch values through per-pane `-e` arguments and Pi Fleet never publishes them to the tmux global environment.
- Zellij receives only a launcher path.
  Launch values briefly exist in a private `0700` launcher that unlinks itself before starting Pi, so Zellij command metadata cannot retain them.
- Peer names, paths, messages, model ids, and errors are treated as untrusted terminal text and sanitized only at display boundaries.
- A same-user process or another privileged Pi extension is outside the security boundary and may inspect process arguments, private runtime files, memory, or environment.
- Pi Fleet separates groups but does not sandbox them from the operating-system user.

## 🚧 Limitations

- Local same-user communication only.
- POSIX Unix-socket transport only.
- Tmux spawning requires tmux 3.2 or newer and an active current pane.
- Ghostty spawning works only on macOS and automatic selection may trigger its Automation permission check.
- Zellij spawning requires Zellij 0.44 or newer in an active pane.
- No LAN, internet, cross-user, remote-host, or public-room transport.
- No daemon, offline mailbox, separate Fleet history, delivery receipt, global ordering, or exactly-once guarantee.
- No automatic trust or discovery of every Pi process.
- No backend fallback after automatic resolution, adapter preflight, or launch failure.
- No automatic close of a split after partial child startup.
- Protocol version 2 intentionally rejects version-1 manifests and frames.
- One request uses one short-lived socket connection; there is no persistent multiplexed channel or delivery stream.
- Server connections use an absolute request deadline rather than an activity-reset timeout, and at most eight message deliveries run concurrently.
- Per-sender and endpoint-wide rate limits are fixed windows, so a busy response can require waiting before retrying.
- Old orphan temporary files, private launchers, and sockets are removed after a grace period.
  Empty private group directories may remain to avoid cross-process startup races.
- No tab, window, resize, focus-navigation, or general layout manager.
- Multiple Pi sessions can still race while editing the same workspace.

## 🗂️ Package layout

```text
packages/pi-fleet/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── pi-fleet.ts                    # Local session launch and messaging
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi Fleet, Pi sessions, tmux split, Ghostty split, Zellij pane, local agents, agent communication, Unix socket, TypeScript.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
