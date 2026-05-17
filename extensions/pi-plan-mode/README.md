# 🧭 pi-plan-mode — Codex-like Plan Mode for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-plan-mode)](https://www.npmjs.com/package/@narumitw/pi-plan-mode) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-plan-mode` adds a Codex-like `/plan` collaboration mode to Pi. Plan mode is for read-only exploration, clarifying questions, and a final implementation-ready `<proposed_plan>` block before any code mutation happens.

Pi core intentionally does not ship a built-in plan mode; this package provides one as an independently installable extension.

## ✨ Features

- Adds `/plan` to enter or manage Plan mode.
- Adds `--plan` to start a session in Plan mode.
- Restricts active tools to read-only tools while Plan mode is active.
- Blocks mutating bash commands such as `rm`, `git commit`, dependency installs, redirects, and editor launches.
- Injects Codex-like Plan mode instructions: explore first, ask only non-discoverable questions, do not mutate files, and finish with `<proposed_plan>`.
- Detects proposed plan blocks and prompts you to implement, revise, or stay in Plan mode.
- Shows Plan mode state in Pi's statusline as `📝 plan active` or `📝 plan ready`.
- Persists Plan mode state in the Pi session so resume restores the mode.

## 📦 Install

```bash
pi install npm:@narumitw/pi-plan-mode
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-plan-mode
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-plan-mode
```

## 🚀 Usage

```text
/plan
/plan <prompt>
```

Use `/plan` to enter Plan mode before writing your planning prompt. Use `/plan <prompt>` to enter Plan mode and immediately submit `<prompt>` as the first Plan-mode user message.

When Plan mode is active, ask the agent to design the change. The agent may inspect files and run read-only commands, but it should not edit files or execute the implementation.

A complete Plan mode answer should include exactly one block like this:

```xml
<proposed_plan>
# Title

## Summary
...

## Key Changes
...

## Test Plan
...

## Assumptions
...
</proposed_plan>
```

After a proposed plan is detected, `/plan` lets you choose whether to implement the plan, revise it, stay in Plan mode, or exit Plan mode. Choosing implementation disables Plan mode, restores full tool access, and immediately starts an implementation turn with the proposed plan.

While Plan mode is enabled, the extension also publishes a compact status for Pi statuslines. With `@narumitw/pi-statusline`, this appears in the extension status area:

- `📝 plan active`: Plan mode is enabled and still gathering context or drafting a plan.
- `📝 plan ready`: A `<proposed_plan>` was detected and is waiting for your next `/plan` action.

You can also exit directly:

```text
/plan exit
```

## 🧠 Codex-like behavior

This extension maps Codex's `ModeKind::Plan` behavior onto Pi's extension API:

- Plan mode is a conversational collaboration mode, not TODO/progress tracking.
- `/plan <prompt>` follows Codex behavior by switching to Plan mode before submitting the inline prompt.
- `update_plan`-style checklist use is discouraged while Plan mode is active.
- The implementation boundary is explicit: Plan mode restores tools before starting implementation, and choosing implementation immediately triggers a normal agent turn with full tool access.
- Pi extension safety is approximated with active-tool restriction plus bash filtering, so it may be stricter or looser than Codex core in edge cases.

## 🗂️ Package layout

```txt
extensions/pi-plan-mode/
├── src/
│   └── plan-mode.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/plan-mode.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, plan mode, Codex-like plan mode, AI coding workflow, read-only planning, implementation plan.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
