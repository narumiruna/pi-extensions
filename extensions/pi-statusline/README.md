# ✨ pi-statusline — Rich Statusline for the Pi Coding Agent

[![npm](https://img.shields.io/npm/v/@narumitw/pi-statusline)](https://www.npmjs.com/package/@narumitw/pi-statusline) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-statusline` is a native [Pi coding agent](https://pi.dev) extension that replaces Pi's footer with a beautiful, information-rich terminal statusline.

Use it to monitor model selection, thinking level, git branch, working directory, active tools, context usage, token totals, estimated cost, time, and statuses from other Pi extensions.

## ✨ Features

- Replaces the default Pi footer with a compact preset-based statusline.
- Shows model, thinking level, git branch, project directory, active tool, context usage, tokens, cost, and clock.
- Displays compact statuses published through Pi's generic extension status API.
- Preserves extension-provided status icons when the status text starts with one.
- Warns when the same extension package is installed from multiple sources.
- Uses emoji-labeled segments for readability in both classic and Tokyo Night presets.
- Adapts to terminal width and truncates safely.
- Requires no configuration, with optional preset selection through `PI_STATUSLINE_PRESET`.

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

## 🎨 Presets

`pi-statusline` supports presets through the `PI_STATUSLINE_PRESET` environment variable:

```bash
PI_STATUSLINE_PRESET=tokyo-night pi
PI_STATUSLINE_PRESET=classic pi
```

Supported presets:

- `tokyo-night` — the default, inspired by the [Starship Tokyo Night preset](https://starship.rs/presets/tokyo-night), using `░▒▓` / `` powerline blocks and the Tokyo Night color ramp.
- `classic` — a compact Pi-themed statusline with left-aligned `•` separators.

Unset or invalid values fall back to `tokyo-night`. Both presets keep the same emoji-labeled information and preserve extension-provided status icons.

## 👀 What it shows

The default `tokyo-night` statusline uses a Starship-inspired `░▒▓` / `` powerline layout and includes:

- `π` brand marker.
- 🤖 current model.
- 🧠 thinking level.
- 📁 current project directory.
- 🌿 git branch.
- ⚙ active or last tool.
- 🪟 context usage percentage.
- 🔢 token totals.
- 💸 estimated cost.
- 🕒 clock.

Statuses from other extensions appear on their own compact line below the main statusline and use each preset's separator.

`pi-statusline` is extension-agnostic: it consumes Pi's generic extension status API and does not import or depend on status-producing extensions. If an extension wants a custom icon, it should include that icon at the start of its status text, for example `ctx.ui.setStatus("goal", "🎯 active")`. Statuses without a leading icon use the generic `🔌` icon.

Examples:

- `🔌 active` for a plain status such as `goal: active`.
- `🎯 active` when the producing extension sets `🎯 active`.
- `🐍 ty ✓ ruff ✓` when the producing extension sets a Python status with a leading icon.
- `🧪 running` when any extension publishes an activity status with its own icon.
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
├── presets/
│   ├── ansi.ts
│   ├── classic.ts
│   ├── tokyo-night.ts
│   └── types.ts
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
