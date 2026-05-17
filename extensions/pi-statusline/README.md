# ✨ pi-statusline — Rich Statusline for the Pi Coding Agent

[![npm](https://img.shields.io/npm/v/@narumitw/pi-statusline)](https://www.npmjs.com/package/@narumitw/pi-statusline) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-statusline` is a native [Pi coding agent](https://pi.dev) extension that replaces Pi's footer with a beautiful, information-rich terminal statusline.

Use it to monitor model selection, thinking level, git branch, working directory, active tools, context usage, token totals, estimated cost, time, and statuses from other Pi extensions.

## ✨ Features

- Replaces the default Pi footer with a compact rich statusline.
- Shows model, thinking level, git branch, project directory, active tool, context usage, tokens, cost, and clock.
- Displays compact statuses from other extensions without knowing about specific packages.
- Preserves extension-provided status icons when the status text starts with one.
- Shows active subagent count and execution mode while subagent tools are running.
- Warns when the same extension package is installed from multiple sources.
- Uses emoji-labeled segments for readability.
- Adapts to terminal width and truncates safely.
- Requires no configuration.

## 📦 Install

```bash
pi install npm:@narumitw/pi-statusline
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-statusline
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-statusline
```

## 👀 What it shows

The default statusline includes:

- `π` brand marker.
- 🤖 current model.
- 🧠 thinking level.
- 🌿 git branch.
- 📁 current project directory.
- 🔧 active or last tool.
- 📊 context usage percentage.
- 🔢 token totals.
- 💰 estimated cost.
- 🕒 clock.

Statuses from other extensions appear on their own compact line below the main statusline and are separated with ``.

`pi-statusline` is extension-agnostic: it does not map package names to icons. If an extension wants a custom icon, it should include that icon at the start of its status text, for example `ctx.ui.setStatus("goal", "🎯 active")`. Statuses without a leading icon use the generic `🔌` icon.

Examples:

- `🔌 active` for a plain status such as `goal: active`.
- `🎯 active` when the producing extension sets `🎯 active`.
- `🔌 ty ✓ ruff ✓` for a plain LSP readiness status.
- `🧑‍🤝‍🧑 2 parallel` while subagent tool calls are active.
- `⚠️ dup biome-lsp` when local and npm installs register the same extension.

## 🧠 Use cases

- Track agent context usage during long coding sessions.
- See which model and thinking level are active.
- Monitor token totals and estimated cost.
- Keep git branch and project directory visible.
- Make Pi terminal sessions easier to scan at a glance.

## 🗂️ Package layout

```txt
extensions/pi-statusline/
├── src/
│   └── statusline.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/statusline.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, statusline, terminal UI, AI coding agent status, token usage, context window, model status, TypeScript Pi package.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
