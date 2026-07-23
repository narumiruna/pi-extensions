# ☕ pi-caffeinate — Keep Your Computer Awake While Pi Works

[![npm](https://img.shields.io/npm/v/@narumitw/pi-caffeinate)](https://www.npmjs.com/package/@narumitw/pi-caffeinate) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-caffeinate` is a cross-platform [Pi coding agent](https://pi.dev) extension that prevents your computer from sleeping while the Pi agent is processing a prompt.

It is designed for long-running coding, refactoring, debugging, web research, and autonomous agent workflows where a suspended laptop or desktop would interrupt progress.

## ✨ Features

- Starts an OS sleep inhibitor when Pi begins processing (`agent_start`).
- Releases the inhibitor when processing ends (`agent_end`) or the session shuts down.
- Publishes the active keep-awake mode as status while an inhibitor is active, unless quiet mode is enabled.
- Supports macOS, Windows, WSL, and Linux.
- Defaults to display-awake mode on every supported OS: prevent system sleep and keep the screen/display awake.
- Provides a single `/caffeinate` command with menu-based controls and direct subcommands.
- Persists the selected keep-awake mode and optional quiet mode in a small JSON settings file.
- Allows a custom inhibitor command through environment configuration.
- Emits plain status text; `@narumitw/pi-statusline` can add or suppress the status icon from JSON config.
- Fails safely when no supported inhibitor is available.

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
pi -e ./extensions/pi-caffeinate
```

## 🖥️ Supported platforms

The default mode is `display` on every supported OS. That means pi-caffeinate prevents system sleep, suspend, or hibernate and keeps the screen/display awake.

Use `/caffeinate sleep` if you want to prevent system sleep while allowing normal display idle behavior such as screen blanking or monitor power-off.

| Platform | `sleep` mode | `display` mode, default |
| --- | --- | --- |
| macOS | `caffeinate -ims` | `caffeinate -dimsu` |
| Windows | PowerShell `SetThreadExecutionState(0x80000001)` | PowerShell `SetThreadExecutionState(0x80000003)` |
| WSL | Windows `powershell.exe` with `SetThreadExecutionState(0x80000001)` | Windows `powershell.exe` with `SetThreadExecutionState(0x80000003)` |
| Linux with systemd | `systemd-inhibit --what=sleep ... sleep infinity` | `systemd-inhibit --what=idle:sleep ... sleep infinity` |
| Linux fallback | `caffeinate -ims` when available | `caffeinate -dimsu` when available |

If no supported inhibitor is available, the extension stays loaded and reports that caffeinate is unavailable.

## 🚀 Commands

```text
/caffeinate
```

Opens keep-awake controls. In non-interactive sessions, it prints command usage and status.

```text
/caffeinate display
```

Keeps the system and screen/display awake. If an inhibitor is currently active, it is restarted so the new mode applies immediately.

```text
/caffeinate sleep
```

Keeps the system awake while allowing normal display sleep. If an inhibitor is currently active, it is restarted so the new mode applies immediately.

```text
/caffeinate status
```

Shows whether an inhibitor is active, unavailable, disabled, or idle. The status includes the current mode, quiet mode, and settings file path.

```text
/caffeinate mode
```

Opens an interactive selector for the keep-awake mode.

```text
/caffeinate stop
```

Releases any active inhibitor until Pi starts another agent run.

## ⚙️ Configuration

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

Set `"quiet": true` to hide the routine `Keeping computer awake (...)` and
`Released pi-caffeinate (agent finished)` lifecycle notifications and keep the `caffeinate` status
item clear while active or unavailable. Quiet mode does not hide warnings or explicit feedback from
`/caffeinate` commands such as `status`, mode changes, help, and manual stop. It defaults to `false`
when omitted. The file is read at startup and on `/reload`; run `/reload` after editing it in a
running Pi session before using mode commands.

Missing, invalid, or deleted settings default back to `display` mode with quiet mode disabled on
every supported OS.

Compatibility: older versions used `pi-caffeinate-settings.json`. During the migration window, a
legacy-only file is automatically migrated to `pi-caffeinate.json` with a warning. If both files
exist, `pi-caffeinate.json` wins and the legacy file is ignored. The legacy filename is deprecated
and will be removed in a future major release.

### Environment variables

Disable the extension:

```bash
PI_CAFFEINATE_DISABLED=1 pi
```

Use a custom inhibitor command:

```bash
PI_CAFFEINATE_COMMAND='systemd-inhibit --what=idle:sleep --why="pi running" --mode=block sleep infinity' pi
```

The custom command is parsed with shell-like quoting and is run directly without a shell. `PI_CAFFEINATE_COMMAND` takes precedence over the saved mode; `/caffeinate status` reports when a custom command is active.

Deprecated: `PI_CAFFEINATE_ICON` still works for now. If you use `@narumitw/pi-statusline`, move the icon to `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-statusline.json`:

```json
{
  "extensionStatusIcons": {
    "caffeinate": "☕️"
  }
}
```

Without `@narumitw/pi-statusline`, keep using `PI_CAFFEINATE_ICON` during the compatibility window. In `pi-statusline.json`, use an empty string to show the caffeinate status without an icon.

## 🧠 Why use pi-caffeinate?

AI coding agents often run tool-heavy tasks that take several minutes. `pi-caffeinate` keeps your machine awake during active Pi work, helping browser automation, local builds, test runs, code generation, and long prompts finish reliably.

The default display-awake mode prioritizes uninterrupted long-running Pi work across platforms, including Linux desktops that require idle inhibition to prevent automatic suspend. Use `/caffeinate sleep` (shown as `system-awake` in status output) when you prefer normal screen power saving and your system does not need idle inhibition to keep Pi running.

## 🗂️ Package layout

```txt
extensions/pi-caffeinate/
├── src/
│   ├── index.ts       # Pi package entrypoint
│   ├── caffeinate.ts  # Extension registration and lifecycle orchestration
│   └── *.ts           # Package-local inhibitor and settings modules
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

`index.ts` is the Pi entrypoint and forwards to `caffeinate.ts`; the other source modules are internal.

## 🔎 Keywords

Pi extension, Pi coding agent, caffeinate, prevent sleep, keep awake, sleep inhibitor, AI agent automation, long-running coding task, TypeScript Pi package.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
