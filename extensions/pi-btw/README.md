# 💬 pi-btw — Side Questions for the Pi Coding Agent

[![npm](https://img.shields.io/npm/v/@narumitw/pi-btw)](https://www.npmjs.com/package/@narumitw/pi-btw) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-btw` is a native [Pi coding agent](https://pi.dev) extension that adds `/btw`, a side-question command for quick clarifications that should not interrupt or pollute the main agent conversation.

Use it when you want to ask a temporary question, inspect context, or get a short explanation while keeping the primary coding task focused.

## ✨ Features

- Adds a `/btw <question>` command to Pi.
- Answers side questions in a temporary, scrollable UI outside Ghostty.
- On macOS Ghostty, opens a forked Pi session in a new Ghostty tab.
- Uses the current session branch as context.
- Does not append inline side questions or answers to the main conversation.
- Works as an independently installable npm Pi extension package.

## 📦 Install

```bash
pi install npm:@narumitw/pi-btw
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-btw
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-btw
```

## 🚀 Usage

```text
/btw <your side question>
```

Examples:

```text
/btw what does this TypeScript error mean?
/btw summarize the current implementation before we continue
/btw is this API name idiomatic?
```

On macOS Ghostty, `/btw` opens a new Ghostty tab and runs `pi --fork` against
the current session, with your side question submitted as the forked session's
first prompt. This keeps the side conversation separate while still letting you
continue chatting in that tab. It requires Ghostty's default
`macos-applescript = true`. If the current Pi session is unsaved or tab creation
fails, `/btw` falls back to the inline pager and shows a warning.

Outside Ghostty, long answers open in a pager-style view. Use `↑`/`↓` or `k`/`j`
to scroll by line, `PgUp`/`PgDn`, `Shift+Space`/`Space`, or `Ctrl+B`/`Ctrl+F` to
scroll by page, `Ctrl+U`/`Ctrl+D` to scroll by half page, and `Home`/`End` to
jump. Close with `q`, `Esc`, `Enter`, or `Ctrl+C`.

## 🖥️ Terminal support notes

- Ghostty on macOS exposes `new tab` via AppleScript, so pi-btw can open a real
  Ghostty tab without extra dependencies and start `pi --fork` there.
- macOS Terminal.app can run commands via AppleScript, but it does not provide a
  reliable direct new-tab command without UI scripting/Accessibility, so pi-btw
  keeps the inline pager there.
- iTerm2 has AppleScript tab/session support and may be added later; this release
  only implements Ghostty.

## 🧠 Why use pi-btw?

Normal assistant messages become part of the main Pi conversation and can distract the coding agent from the task. `pi-btw` creates a lightweight side channel for context-aware questions, making it useful for pair programming, debugging, code review, and repository exploration.

## 🗂️ Package layout

```txt
extensions/pi-btw/
├── src/
│   └── btw.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/btw.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, AI coding agent, side question command, agent chat workflow, TypeScript Pi package, npm Pi extension.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
