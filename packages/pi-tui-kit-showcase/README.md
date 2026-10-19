# 🧭 Pi TUI Kit Showcase — Preview Standard Pi Interactions

[![private](https://img.shields.io/badge/npm-private-lightgrey)](./package.json) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

This local maintainer demo previews the public `@narumitw/pi-tui-kit` screens and standalone interactions in one menu.
All demo state stays in memory, and the showcase writes no settings.

## ✨ Features

- Includes action, detail, browse, choice, settings, input, review, and multi-select screens.
- Includes standalone document review, multi-select, masked input, model and thinking selectors, questionnaire, task, confirmation, and live-choice interactions.
- Previews exact text, code, diff, and Markdown reviews, including Mermaid and LaTeX rendering or source display.
- Demonstrates document search, editable input prefills and validation, transactional selection, disabled rows, busy labels, bulk actions, and row descriptions.
- Shows the shared top and bottom rules on every standard screen at normal terminal heights.
- Keeps every demo effect in memory.
- Loads the Kit runtime only after `/tui-kit-showcase` runs.

## 📦 Install

This package is private and is not meant for npm publication.
Load only trusted extension code: it runs with Pi's operating-system permissions.
Install dependencies and build Kit, then load only this extension from a local checkout:

```bash
npm install
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
Standalone interactions temporarily close the menu and reopen it after completion or Back.
Ctrl+C exits the showcase from selectors, reviews, questionnaires, confirmations, and masked input.
Task cancellation returns to the menu because `runTask()` reports one cancellation result without a Back or Close reason.
The input screen accepts a trimmed note of 1–80 characters and keeps rejected drafts open for editing.
RPC mode reports that the showcase requires TUI mode.
Print and JSON modes reject the command without ad hoc output.

## ⚙️ Settings

The showcase has no extension-owned settings file.
The **Settings screen** row changes only in-memory demo values.
Those values reset when the command runs again or Pi replaces the session owner.
Model and thinking selectors use synthetic demo state; selecting or saving a default does not change Pi's model, thinking level, or settings.
Standalone multi-select applies changes only through **Apply demo**; Back discards them.

## 🔒 Security and privacy

Use sample text in **Secret input**, not real credentials.
The showcase discards submitted masked values without adding them to demo state, logs, or notifications.
Masking does not provide secure erasure from the JavaScript runtime.
No demo sends provider requests or writes settings.

## 💬 Commands

Run `/tui-kit-showcase` to browse interactive component demos in TUI mode.
It accepts no arguments and rejects RPC, print, and JSON modes.

## 🧪 Verification

Automated tests cover screen options, completion, cancellation, owner replacement, width bounds, input editing, and Pi Jiti loading.
Maintainers must use `npm run showcase:tui-kit` for manual review of terminal appearance, IME input, and mouse behavior; automated tests do not replace these checks.

## 🗂️ Package layout

```text
packages/pi-tui-kit-showcase/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   ├── showcase.ts                    # Command and lifecycle; lazy runtime loading
│   ├── runtime.ts                     # Standalone interactions and menu handoffs
│   ├── menu.ts                        # Declarative screens and in-memory actions
│   └── review-examples.ts             # Static document samples
└── test/                              # Behavior and lifecycle coverage
```

## 🔎 Keywords

pi, pi-extension, tui, showcase, demo

## 📄 License

[MIT](./LICENSE) © narumiruna
