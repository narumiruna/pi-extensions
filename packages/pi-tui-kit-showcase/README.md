# 🧭 Pi TUI Kit Showcase — Preview Standard Pi Interactions

[![private](https://img.shields.io/badge/npm-private-lightgrey)](./package.json) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

This local maintainer demo previews the public `@narumitw/pi-tui-kit` screens and standalone interactions in one menu.
All demo state stays in memory, and the showcase writes no settings.

## ✨ Features

- Includes action, detail, browse, choice, settings, input, review, and multi-select screens.
- Includes standalone questionnaire, task, confirmation, and live-choice interactions.
- Demonstrates disabled rows, busy labels, search, exact documents, adaptive review, bulk actions, and row descriptions.
- Shows the shared top and bottom rules on every standard screen at normal terminal heights.
- Keeps every demo effect in memory.
- Loads the Kit runtime only after `/tui-kit-showcase` runs.

## 📦 Install

This package is private and is not meant for npm publication.
Build Kit, then load only this extension from a local checkout:

```bash
npm run build --workspace @narumitw/pi-tui-kit
pi --no-extensions --no-skills --no-session -e ./packages/pi-tui-kit-showcase
```

The repository shortcut runs the same build before opening the showcase:

```bash
npm run showcase:tui-kit
```

## 🚀 Quick start

Run this command in Pi TUI mode:

```text
/tui-kit-showcase
```

Choose a row to inspect its screen or interaction pattern.
Questionnaire, task, confirmation, and live-choice rows temporarily close the menu and reopen it after the interaction finishes.
RPC mode reports that the showcase requires TUI mode.
Print and JSON modes reject the command without ad hoc output.

## ⚙️ Settings

The showcase has no extension-owned settings file.
The **Settings screen** row changes only in-memory demo values.
Those values reset when the command runs again or Pi replaces the session owner.

## 💬 Commands

Run `/tui-kit-showcase` to browse interactive component demos in TUI mode.
It accepts no arguments and rejects RPC, print, and JSON modes.

## 🗂️ Package layout

```text
packages/pi-tui-kit-showcase/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── showcase.ts                    # Demo command and lifecycle
└── test/                              # Behavior and lifecycle coverage
```

## 🔎 Keywords

pi, pi-extension, tui, showcase, demo

## 📄 License

[MIT](./LICENSE) © narumiruna
