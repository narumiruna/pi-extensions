# 🧭 pi-plan-mode — Codex-like Plan Mode for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-plan-mode)](https://www.npmjs.com/package/@narumitw/pi-plan-mode) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-plan-mode` adds a Codex-like `/plan` collaboration mode to Pi. Plan mode is for read-only exploration, clarifying questions, and a final implementation-ready `<proposed_plan>` block before any code mutation happens.

Pi core intentionally does not ship a built-in plan mode; this package provides one as an independently installable extension.

## ✨ Features

- Adds `/plan` to enter or manage Plan mode.
- Adds `--plan` to start a session in Plan mode.
- Enables built-in read-only tools by default while Plan mode is active.
- Disables extension and custom tools by default, with a `/plan tools` selector for explicit user-risk opt-in.
- Blocks mutating built-in tools and bash commands such as `rm`, `git commit`, dependency installs, redirects, and editor launches.
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
/plan tools
```

Use `/plan` to enter Plan mode before writing your planning prompt. Use `/plan <prompt>` to enter Plan mode and immediately submit `<prompt>` as the first Plan-mode user message. Use `/plan tools` to choose which tools are active while Plan mode is enabled; the selector is paginated at 10 tools per page.

When Plan mode is active, ask the agent to design the change. The agent may inspect files and run read-only commands, but it should not edit files or execute the implementation.

By default, Plan mode manages only Pi's built-in tools: `read`, limited `bash`, and available read-only built-ins such as `grep`, `find`, and `ls`. Built-in `edit` and `write` are blocked. Extension and custom tools are disabled by default because Pi tools do not expose standardized mutability metadata; enable them from `/plan tools` only when you accept the risk for that session. For example, you can opt into `firecrawl_scrape`, `firecrawl_search`, or `biome_lsp_diagnostics` if those extensions are loaded and you want to use them during planning.

Pi activates tools by tool name. The `/plan tools` selector stores selections by name and shows each currently effective tool's source from Pi metadata, such as `built-in`, a user extension path, or a project extension path. If an extension overrides a built-in tool with the same name, Pi exposes the effective tool for that name and the selector shows that source.

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
- Pi extension safety is approximated with built-in tool restriction plus bash filtering; non-built-in tools are user-selected at user risk because Plan mode does not classify extension/custom tool behavior.

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
