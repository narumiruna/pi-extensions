# ◧ pi-sidebar — Opencode-style Sidebar for the Pi Coding Agent

[![npm](https://img.shields.io/npm/v/@narumitw/pi-sidebar)](https://www.npmjs.com/package/@narumitw/pi-sidebar) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

> Deprecated: this package is kept for reference under `deprecated/` and is no longer part of the active workspace package set.

`@narumitw/pi-sidebar` is a native [Pi coding agent](https://pi.dev) extension that adds an opencode-inspired right sidebar overlay to Pi's interactive terminal UI.

It keeps session state, model information, context usage, running tools, and recent activity visible while leaving the main editor focused.

## ✨ Features

- Shows a right-side non-capturing overlay sidebar in interactive Pi sessions.
- Tracks model/provider, thinking level, cwd, git branch, turns, context usage, token totals, and cost.
- Shows currently running tools and a compact list of enabled tools.
- Streams recent prompt, model, agent, and tool activity with relative timestamps.
- Auto-hides on narrow terminals to avoid covering the main UI.
- Provides `/sidebar` and `alt+s` toggles.
- Uses only Pi's extension TUI APIs; no Pi core patch is required.

## 📦 Install

```bash
pi install npm:@narumitw/pi-sidebar
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-sidebar
```

Try this package locally from the repository root:

```bash
pi -e ./deprecated/pi-sidebar
```

## 🚀 Usage

The sidebar opens automatically in interactive terminal sessions.

Commands:

- `/sidebar` or `/sidebar toggle` — toggle the sidebar.
- `/sidebar on` — show the sidebar.
- `/sidebar off` — hide the sidebar.
- `/sidebar refresh` — refresh git branch information.

Shortcut:

- `alt+s` — toggle the sidebar.

## ⚙️ Configuration

Configure the first version with environment variables before starting Pi:

| Variable | Default | Description |
| --- | --- | --- |
| `PI_SIDEBAR_DEFAULT` | `true` | Show the sidebar on session start. Set to `false`, `0`, or `off` to start hidden. |
| `PI_SIDEBAR_WIDTH` | `42` | Sidebar overlay width in columns, or a percentage such as `30%`. |
| `PI_SIDEBAR_MIN_TERMINAL_WIDTH` | `100` | Hide the sidebar when the terminal is narrower than this many columns. |

Example:

```bash
PI_SIDEBAR_WIDTH=36 PI_SIDEBAR_MIN_TERMINAL_WIDTH=120 pi -e npm:@narumitw/pi-sidebar
```

## 🧪 Current limitations

This is an overlay-style sidebar, not a true split-pane layout. It does not reserve terminal columns or shrink Pi's main conversation view. A permanent split sidebar would require a Pi core layout extension point such as `ctx.ui.setSidebar()`.

## 🗂️ Package layout

```txt
deprecated/pi-sidebar/
├── src/
│   └── sidebar.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/sidebar.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, sidebar, opencode-style UI, TUI overlay, terminal UI, TypeScript Pi package.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
