# ☕ pi-caffeinate — Keep Your Computer Awake While Pi Works

[![npm](https://img.shields.io/npm/v/@narumitw/pi-caffeinate)](https://www.npmjs.com/package/@narumitw/pi-caffeinate) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-caffeinate` is a cross-platform [Pi coding agent](https://pi.dev) extension that prevents your computer from sleeping while the Pi agent is processing a prompt.

It is designed for long-running coding, refactoring, debugging, web research, and autonomous agent workflows where a suspended laptop or desktop would interrupt progress.

## ✨ Features

- Starts an OS sleep inhibitor when Pi begins processing (`agent_start`).
- Releases the inhibitor when processing ends (`agent_end`) or the session shuts down.
- Publishes an `awake` status only while an inhibitor is active.
- Supports macOS, Windows, WSL, and Linux.
- Provides `/caffeinate-status` and `/caffeinate-stop` commands.
- Allows a custom inhibitor command through environment configuration.
- Allows a custom status icon through environment configuration.
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

- macOS: uses `caffeinate -dimsu`.
- Windows: uses PowerShell `SetThreadExecutionState`.
- WSL: uses Windows `powershell.exe` with `SetThreadExecutionState`.
- Linux: uses `systemd-inhibit` with `sleep infinity`.
- Linux fallback: uses `caffeinate -dimsu` when available.

If no supported inhibitor is available, the extension stays loaded and reports that caffeinate is unavailable.

## 🚀 Commands

```text
/caffeinate-status
```

Shows whether an inhibitor is active, unavailable, or disabled.

```text
/caffeinate-stop
```

Manually releases any active inhibitor for the current session.

## ⚙️ Configuration

Disable the extension:

```bash
PI_CAFFEINATE_DISABLED=1 pi
```

Use a custom inhibitor command:

```bash
PI_CAFFEINATE_COMMAND='systemd-inhibit --what=idle:sleep --why="pi running" --mode=block sleep infinity' pi
```

The custom command is parsed with shell-like quoting and is run directly without a shell.

Customise the status bar icon (default: `💊`):

```bash
PI_CAFFEINATE_ICON='☕️' pi
```

## 🧠 Why use pi-caffeinate?

AI coding agents often run tool-heavy tasks that take several minutes. `pi-caffeinate` keeps your machine awake during active Pi work, helping browser automation, local builds, test runs, code generation, and long prompts finish reliably.

## 🗂️ Package layout

```txt
extensions/pi-caffeinate/
├── src/
│   └── caffeinate.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

## 🔎 Keywords

Pi extension, Pi coding agent, caffeinate, prevent sleep, keep awake, sleep inhibitor, AI agent automation, long-running coding task, TypeScript Pi package.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
