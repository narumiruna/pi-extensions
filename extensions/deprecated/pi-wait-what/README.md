# 🤔 pi-wait-what — Pause and Ask What the Agent Is Doing

[![npm](https://img.shields.io/npm/v/@narumitw/pi-wait-what)](https://www.npmjs.com/package/@narumitw/pi-wait-what) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

> Deprecated: this package is kept for reference under `extensions/deprecated/` and is no longer part of the active workspace package set. Manually pausing the agent and using [`/btw`](../../pi-btw) provides the same core workflow through a side question.

`@narumitw/pi-wait-what` is a native [Pi coding agent](https://pi.dev) extension that adds `/wait-what`, a quick command for pausing the main conversation and asking the agent to explain surprising behavior.

Use it when the agent starts doing something unexpected, unclear, or more aggressive than you intended and you want it to explain before continuing.

## ✨ Features

- Adds a `/wait-what` command to Pi.
- Works with or without an extra concern/question.
- Sends a main-conversation steering message, so the agent remembers the interruption.
- Asks the agent to avoid tools in the explanation response.
- Uses a fixed checklist: what it was doing, why, assumptions, next step, and what it needs from you.
- Keeps v0 simple: no automatic detection, no custom UI, no shortcuts, no aborts, and no tool blocking.
- Works as an independently installable npm Pi extension package.

## 📦 Install

```bash
pi install npm:@narumitw/pi-wait-what
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-wait-what
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/deprecated/pi-wait-what
```

## 🚀 Usage

```text
/wait-what
/wait-what <your concern or question>
```

Examples:

```text
/wait-what
/wait-what why are you editing package-lock?
/wait-what I thought we agreed not to implement yet
```

When triggered, the extension sends a user message like:

```text
Wait, what? Pause here and explain what you were doing before taking any more actions.

Respond in the current conversation language. Do not call tools in this response. Be concise and use this checklist:

1. What you were doing
2. Why you chose that action
3. What you assumed
4. What you were about to do next
5. What you need from me before continuing

After explaining, wait for my confirmation before continuing.
```

If you include a concern, the command adds it to the message and asks the agent to address it directly.

## ⚠️ Limitations

`pi-wait-what` is intentionally prompt-only in v0. It does not abort already-running tools and does not hard-block future tool calls. When the agent is busy, the extension uses Pi's steering delivery mode, so the wait-what message is inserted before the next model turn after the current tool batch finishes.

If you need to continue after the explanation, just type a normal reply such as `ok continue`, `no, do not edit that file`, or another follow-up question.

## 🗂️ Package layout

```txt
extensions/deprecated/pi-wait-what/
├── src/
│   └── wait-what.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/wait-what.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, wait what, pause agent, agent clarification, steering command, TypeScript Pi package, npm Pi extension.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
