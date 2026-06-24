# ✨ pi-statusline — Rich Statusline for the Pi Coding Agent

[![npm](https://img.shields.io/npm/v/@narumitw/pi-statusline)](https://www.npmjs.com/package/@narumitw/pi-statusline) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-statusline` is a native [Pi coding agent](https://pi.dev) extension that replaces Pi's footer with a beautiful, information-rich terminal statusline.

Use it to monitor model selection, thinking level, git branch, working directory, active tools, context usage, token totals, estimated cost, time, and statuses from other Pi extensions.

## ✨ Features

- Replaces the default Pi footer with a compact preset-based statusline.
- Shows model, thinking level, git branch, project directory, active tool, context usage, tokens, cost, and clock.
- Displays compact statuses published through Pi's generic extension status API.
- Owns extension status icons through optional JSON config, including per-extension icon suppression with `""`.
- Warns when the same extension package is installed from multiple sources.
- Uses emoji-labeled segments for readability in both classic and Tokyo Night presets.
- Adapts to terminal width and wraps long extension status lines safely.
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

Unset or invalid values fall back to `tokyo-night`. Both presets keep the same emoji-labeled information.

## ⚙️ Extension status icons

Extension statuses use built-in icons by status key. Override or suppress them in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-statusline-settings.json`:

```json
{
  "extensionStatusIcons": {
    "caffeinate": "☕",
    "github-pr": "🔎",
    "goal": "🎯",
    "pisync": "☁️",
    "unknown-error-retry": "",
    "plan-mode": "📝",
    "subagents": "🤖"
  }
}
```

- Missing key: use the built-in icon, or `🔌` for an unknown status key.
- String value: use that string as the icon.
- Empty string: show the status text without an icon.
- `PI_STATUSLINE_PRESET` remains the only preset setting; this JSON file only controls extension status icons.

During the `PI_CAFFEINATE_ICON` deprecation window, a leading emoji from `pi-caffeinate` is still used when JSON does not configure `caffeinate`. JSON wins when both are set.

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

Statuses from other extensions appear below the main statusline, use each preset's separator, and wrap onto additional footer lines when they exceed the terminal width.

`pi-statusline` is extension-agnostic: it consumes Pi's generic extension status API and does not import or depend on status-producing extensions.

Examples:

- `🎯 active` for `goal: active` using the built-in `goal` icon.
- `🔎 PR #123 checks passing` for `github-pr: PR #123 checks passing` using the built-in `github-pr` icon.
- `☕ display` when JSON config sets `"caffeinate": "☕"`.
- `receiving` when JSON config sets `"unknown-error-retry": ""`.
- `🔌 running` for an unknown extension status key with no configured icon.
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
