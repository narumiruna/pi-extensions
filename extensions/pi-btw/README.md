# 💬 pi-btw — Side Questions for the Pi Coding Agent

[![npm](https://img.shields.io/npm/v/@narumitw/pi-btw)](https://www.npmjs.com/package/@narumitw/pi-btw) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-btw` is a native [Pi coding agent](https://pi.dev) extension that adds `/btw`, a side-question command for quick clarifications that should not interrupt or pollute the main agent conversation.

Use it when you want to ask a temporary question, inspect context, or get a short explanation while keeping the primary coding task focused.

## ✨ Features

- Adds a `/btw <question>` command to Pi.
- Answers side questions in a temporary, scrollable UI.
- Uses the current session branch as context.
- Inherits Pi's current thinking level or uses a fixed level from `pi-btw.json`.
- Does not append the side question or answer to the main conversation.
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

Long answers open in a pager-style view. Use `↑`/`↓` or `k`/`j` to scroll by line,
`PgUp`/`PgDn`, `Shift+Space`/`Space`, or `Ctrl+B`/`Ctrl+F` to scroll by page,
`Ctrl+U`/`Ctrl+D` to scroll by half page, and `Home`/`End` to jump. Close with
`q`, `Esc`, `Enter`, or `Ctrl+C`.

## ⚙️ Thinking level

Pi calls its reasoning setting the **thinking level**. By default, `/btw` inherits the
current runtime level, including changes made through `/settings` or `Shift+Tab`. It does
not read or change `defaultThinkingLevel` directly.

To request a fixed level for side questions, create:

```text
$PI_CODING_AGENT_DIR/pi-btw.json
```

The normal location is `~/.pi/agent/pi-btw.json`. `PI_CODING_AGENT_DIR` is an existing Pi
setting; pi-btw does not add any environment variables.

```json
{
  "thinkingLevel": "low"
}
```

Supported values are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. The selected
value affects only `/btw` requests and does not change the main session. Pi's provider
layer may clamp a requested level when the active model does not support it.

The settings file is optional and is never created automatically. A missing file, `{}`,
or an omitted `thinkingLevel` silently inherits the current Pi level. The file is read for
each `/btw` invocation, so edits apply to the next side question without `/reload`. Invalid
or unreadable settings produce a warning and fall back to the current Pi level.

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
