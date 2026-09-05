# ☕ pi-caffeinate — Keep Your Computer Awake While Pi Runs

[![npm](https://img.shields.io/npm/v/@narumitw/pi-caffeinate)](https://www.npmjs.com/package/@narumitw/pi-caffeinate) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Prevent system or display sleep while Pi is running an agent task, then release the inhibitor when the run ends.

## ✨ Features

- Starts an OS sleep inhibitor when a Pi run begins and releases it when the run or session ends.
- Supports macOS, Windows, WSL, and Linux, with display-awake as the default.
- Provides `/caffeinate` controls for keep-awake mode and status.
- Persists preferences locally and accepts an optional custom inhibitor command.
- Falls back when possible, warns on partial activation, and reports when no inhibitor is available.

## 📦 Install

```bash
pi install npm:@narumitw/pi-caffeinate
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-caffeinate
```

Try this package locally from the repository root:

```bash
npm --workspace @narumitw/pi-caffeinate run build
pi -e ./packages/pi-caffeinate
```

The package declares `dist/index.ts`, so an unbuilt local checkout must be built before Pi loads the package directory.
Pi extensions run with the Pi process's user permissions, so install only trusted packages.

## 🚀 Quick start

Load the extension and use Pi normally.
During each agent run, pi-caffeinate uses the saved mode and defaults to keeping the system and display awake.
Run `/caffeinate` for controls or `/caffeinate status` for the current state.

## 🖥️ Supported platforms

The default `display` mode prevents system sleep, suspend, or hibernate and keeps the display awake.
Use `/caffeinate sleep` to prevent system sleep while allowing normal screen blanking or monitor power-off.

| Platform | `sleep` mode | `display` mode, default |
| --- | --- | --- |
| macOS | `caffeinate -ims` | `caffeinate -dimsu` |
| Windows | PowerShell `SetThreadExecutionState(0x80000001)` | PowerShell `SetThreadExecutionState(0x80000003)` |
| WSL | Windows `powershell.exe` with `SetThreadExecutionState(0x80000001)` | Windows `powershell.exe` with `SetThreadExecutionState(0x80000003)` |
| Linux with systemd | `systemd-inhibit --what=sleep ... sleep infinity` | D-Bus `org.freedesktop.ScreenSaver.Inhibit` + `systemd-inhibit --what=idle:sleep ... sleep infinity` |
| Linux without systemd | `caffeinate -ims` when available | D-Bus `org.freedesktop.ScreenSaver.Inhibit` + `caffeinate -dimsu` when available; D-Bus only otherwise |

On Linux, `display` mode requests idle inhibition from `org.freedesktop.ScreenSaver` over D-Bus.
It tries `/org/freedesktop/ScreenSaver` and `/ScreenSaver` for desktop compatibility and keeps the session-bus connection open for the agent turn.
Calling `UnInhibit` or closing the connection releases the request.
`systemd-inhibit --what=idle:sleep` runs alongside D-Bus to preserve logind idle and sleep inhibition.
If the ScreenSaver service is unavailable, pi-caffeinate keeps the systemd or `caffeinate` blocker and warns that activation is partial.
If only D-Bus is available, it warns that direct system suspend may remain possible.
D-Bus calls have 2-second deadlines, and stop or shutdown aborts an in-progress acquisition before closing the connection.

If no supported inhibitor is available, the extension stays loaded and reports that caffeinate is unavailable.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/caffeinate` | Open keep-awake controls in TUI or RPC. |
| `/caffeinate display` | Keep the system and display awake. |
| `/caffeinate sleep` | Keep the system awake while allowing display sleep. |
| `/caffeinate status` | Show inhibitor state, mode, quiet mode, and settings path. |
| `/caffeinate mode` | Open the TUI/RPC mode selector; Escape closes it. |
| `/caffeinate stop` | Release the inhibitor until the next agent run. |
| `/caffeinate help` | Show canonical command routes. |

Changing to `display` or `sleep` restarts an active inhibitor so the mode applies immediately.
Print and JSON modes reject the interactive menu.
Direct routes avoid interactive UI, but those modes do not display their notification feedback.
In TUI and RPC mode, unknown commands and trailing text show a rejection with the command guide.
Compatibility aliases are `screen` for `display`, `system` for `sleep`, `off` for `stop`, and `config` or `settings` for `mode`.

## ⚙️ Settings

### Persisted settings

`/caffeinate sleep` and `/caffeinate display` save the selected mode to:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-caffeinate.json
```

Example:

```json
{
  "mode": "display",
  "quiet": true,
  "updatedAt": 1791763200000
}
```

Set `"quiet": true` to hide routine start and release notifications and clear the `caffeinate` status item while active or unavailable.
Quiet mode does not hide warnings or explicit command feedback.
It defaults to `false` when omitted.
The file is read at startup and on `/reload`.
After editing it in a running session, run `/reload` before using mode commands.

Missing, invalid, or deleted settings use `display` mode with quiet mode off.
A missing file stays absent until the first successful mode change.
Within one Pi process, mode saves run in invocation order, reread the latest valid document, and preserve unknown fields.
Malformed JSON or an invalid recognized field blocks saves until repaired.
A failed save keeps the previous runtime mode.
If applying a published mode fails while an inhibitor is active, the extension restores the previous saved mode and inhibitor or reports a rollback failure.

Older versions used `pi-caffeinate-settings.json`.
A legacy-only file remains readable with a warning and is not modified automatically; rename it to `pi-caffeinate.json`.
The next settings save writes the canonical file.
If both files exist, `pi-caffeinate.json` takes precedence.
The legacy filename is deprecated and will be removed in a future major release.

### Environment variables

Disable the extension:

```bash
PI_CAFFEINATE_DISABLED=1 pi
```

Use a custom inhibitor command:

```bash
PI_CAFFEINATE_COMMAND='systemd-inhibit --what=idle:sleep --why="pi running" --mode=block sleep infinity' pi
```

The custom command uses shell-like argument parsing but runs directly without a shell.
`PI_CAFFEINATE_COMMAND` overrides the saved mode, and `/caffeinate status` reports the override.

Deprecated: `PI_CAFFEINATE_ICON` still works for now.
If you use `@narumitw/pi-statusline`, move the icon to `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-statusline.json`:

```json
{
  "extensionStatusIcons": {
    "caffeinate": "☕️"
  }
}
```

Without `@narumitw/pi-statusline`, keep using `PI_CAFFEINATE_ICON` during the compatibility window.
In `pi-statusline.json`, use an empty string to show caffeinate status without an icon.

Status output calls `display` mode `display-awake` and `sleep` mode `system-awake`.

## 📦 Dependencies

On Linux, `display` mode uses the pure-JavaScript `dbus-native` package to call `org.freedesktop.ScreenSaver` on the session bus.

## 🗂️ Package layout

```text
packages/pi-caffeinate/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── caffeinate.ts                  # Sleep inhibitors and lifecycle
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, caffeinate, prevent sleep, keep awake, sleep inhibitor, AI agent automation, long-running coding task, TypeScript Pi package.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
