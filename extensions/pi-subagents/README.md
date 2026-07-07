# 🧑‍🤝‍🧑 pi-subagents — Isolated Subagents for the Pi Coding Agent

[![npm](https://img.shields.io/npm/v/@narumitw/pi-subagents)](https://www.npmjs.com/package/@narumitw/pi-subagents) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-subagents` is a native [Pi coding agent](https://pi.dev) extension that adds a `subagent` tool for delegating work to specialized agents running in isolated Pi subprocesses.

Use it to split research, planning, implementation, and review work across focused workers while keeping each subprocess context, tools, and prompt boundary separate from the main conversation.

## ✨ Features

- Registers a `subagent` tool for single-agent, parallel, fan-in, and chained delegation.
- Runs workers as isolated `pi --mode json -p --no-session` subprocesses.
- Supports built-in `scout`, `planner`, `reviewer`, and `worker` agents.
- Loads custom user agents from `~/.pi/agent/agents/*.md`.
- Optionally loads project agents from `.pi/agents/*.md` with confirmation.
- Provides `/subagents:config` to persist per-agent tool allow-lists.
- Supports per-task `cwd`, hard subprocess `timeoutMs`, abort propagation, and streaming progress.
- Publishes transient runtime status through Pi's generic extension status API while subagents are running.
- Returns complete worker output in tool details and a concise result for the main agent.

## 📦 Install

```bash
pi install npm:@narumitw/pi-subagents
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-subagents
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-subagents
```

## 🛠️ Pi tool

`pi-subagents` registers one tool:

- `subagent` — delegate work to one or more specialized agents.

Execution modes:

- **single** — run one `{ agent, task }` job.
- **parallel** — run multiple `{ agent, task }` jobs independently.
- **parallel + aggregator** — run parallel jobs, then pass all outputs into one fan-in agent.
- **chain** — run sequential steps, passing prior output with `{previous}`.

## 🧭 Proactive use

The `subagent` tool advertises concise prompt guidance so the main Pi agent can decide
whether to spawn 0, 1, or multiple subagents without an explicit user-specified count.

Count-selection guidance:

- Use **no subagent** for simple answers, quick targeted edits, latency-sensitive one-step work, or
  tasks that need frequent user back-and-forth.
- Use **one subagent** for isolated research, high-volume command output, planning, or independent
  review/verification after implementation.
- Prefer **2–4 parallel read-only subagents** when a broad task naturally splits into independent
  branches that can each return a concise summary.
- Exceed 4 tasks only when the branches are clearly distinct and worth the extra cost, while staying
  within the existing hard max of 8 parallel tasks.
- Do not parallelize implementation that may edit the same files or shared state; serialize
  write-heavy work instead.
- Do not use project-local agents unless the user explicitly opts into them with
  `agentScope: "project"` or `"both"`; keep confirmation enabled for untrusted repositories.

Examples where the main agent chooses the count:

No subagent for a known-file edit:

```txt
Rename one symbol in src/foo.ts.
```

One subagent for an independent review:

```json
{
  "agent": "reviewer",
  "task": "Review the current changes for release blockers. Do not edit files. Report PASS/FAIL/PARTIAL with evidence."
}
```

Two to four parallel subagents for broad independent reconnaissance:

```json
{
  "tasks": [
    {
      "agent": "scout",
      "task": "Research auth-related source files. Report paths and open questions. Do not edit files."
    },
    {
      "agent": "scout",
      "task": "Research auth-related tests. Report coverage gaps. Do not edit files."
    },
    {
      "agent": "scout",
      "task": "Research API entry points that depend on auth. Report integration risks. Do not edit files."
    }
  ],
  "aggregator": {
    "agent": "reviewer",
    "task": "Merge these findings into a concise implementation-risk summary. Use {previous}."
  }
}
```

## 🚀 Examples

Run one read-only reconnaissance agent:

```json
{
  "agent": "scout",
  "task": "Find the statusline extension entry points"
}
```

Run multiple agents in parallel:

```json
{
  "tasks": [
    {
      "agent": "scout",
      "task": "Map package metadata files",
      "timeoutMs": 30000
    },
    {
      "agent": "reviewer",
      "task": "Review TypeScript config consistency"
    }
  ],
  "timeoutMs": 120000
}
```

Run parallel workers, then aggregate their results:

```json
{
  "tasks": [
    { "agent": "scout", "task": "Find auth-related code" },
    { "agent": "scout", "task": "Find auth-related tests" }
  ],
  "aggregator": {
    "agent": "reviewer",
    "task": "Merge, dedupe, and verify these findings. Use {previous}."
  }
}
```

Run a chain where each step receives the previous output:

```json
{
  "chain": [
    { "agent": "scout", "task": "Find subagent-related code" },
    {
      "agent": "planner",
      "task": "Using this context, plan the extension: {previous}"
    }
  ]
}
```

## 🤖 Built-in agents

Built-in agents are available without setup and can be overridden by user or project agents with the same name.

| Agent | Purpose | Tools |
| --- | --- | --- |
| `scout` | Read-only codebase reconnaissance. | `read`, `grep`, `find`, `ls`, `bash` |
| `planner` | Grounded implementation plans. | `read`, `grep`, `find`, `ls` |
| `reviewer` | Independent review and verification. | `read`, `grep`, `find`, `ls`, `bash` |
| `worker` | General-purpose implementation. | Pi default tools |
| `general`, `general-purpose` | Aliases for `worker`. | Pi default tools |

Built-in agents inherit the active/default Pi model instead of forcing a provider-specific model alias, which keeps subprocesses usable across different Pi setups.

## ⚙️ Configure agent tools

Run `/subagents:config` in an interactive Pi session to edit the tools each subagent may use.
The command stores settings in `~/.pi/agent/pi-subagents-config.json`.

- Select an agent, then press Enter or Space to toggle tools.
- Press `S` to save, or Esc to cancel and return to agent selection.
- Save the default selection to remove a custom override and use the agent defaults again.
- Deselect every tool and save to run that agent with no tools.

Configured tool names that are not currently registered are preserved, so settings for tools from
other extension sessions are not silently dropped.

## 🧩 Custom agents

Create markdown agent definitions in either location:

- `~/.pi/agent/agents/*.md` for user agents.
- `.pi/agents/*.md` for project-local agents.

Example:

```markdown
---
name: api-reviewer
description: Review API changes for compatibility and tests
tools: read, grep, find, ls, bash
model: sonnet
---

You are an API review subagent. Do not edit files. Check compatibility,
test coverage, and migration risks. Report PASS/FAIL/PARTIAL with evidence.
```

By default, `subagent` loads user agents only. Set `agentScope` to `"project"` or `"both"` to load project-local agents. Interactive sessions ask for confirmation before using project agents unless `confirmProjectAgents` is disabled.

## ⏱️ Runtime limits

Each subprocess has a hard timeout to avoid runaway workers.

- Set `timeoutMs` on the top-level call to apply a default for all jobs.
- Set `timeoutMs` on a task, chain step, or aggregator to override it locally.
- If omitted, the default is `PI_SUBAGENT_TIMEOUT_MS`, or `600000` milliseconds (10 minutes) when unset.

On timeout, the extension sends `SIGTERM`, escalates to `SIGKILL` after a short grace period, and returns any partial messages or stderr collected so far.

## 📡 Runtime status

While the `subagent` tool is running, `pi-subagents` publishes compact activity status with `ctx.ui.setStatus("subagents", "...")`. Any statusline extension that reads Pi's generic extension status API can display it; no package-to-package dependency is required.

## 🔒 Safety notes

Subagents are separate Pi processes and may use the tools allowed by their agent definition. Treat project-local agent prompts like executable project configuration: only enable them in trusted repositories.

## 🗂️ Package layout

```txt
extensions/pi-subagents/
├── src/
│   └── subagents.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/subagents.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, subagents, agent delegation, parallel agents, fan-in aggregation, chained agents, isolated subprocesses, AI coding workflow, TypeScript Pi package.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
