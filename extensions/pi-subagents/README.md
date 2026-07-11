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
- Supports per-task `cwd`, hard subprocess `timeoutMs`, `thinkingLevel`, abort propagation, and streaming progress.
- Bounds JSON lines, captured messages, stderr, final output, chain substitution, and fan-in context.
- Enforces a recursion-depth guard and deterministic process-group termination.
- Optionally provides addressable stateful agents with follow-up, wait, list, interrupt, close, context selection, and persistence.
- Publishes transient runtime status through Pi's generic extension status API while subagents are running.
- Returns complete bounded worker output in tool details and a concise result for the main agent.

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

Common controls:

- `cwd` — run a job from a different working directory.
- `timeoutMs` — set a hard subprocess timeout.
- `thinkingLevel` — request `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` thinking for the spawned Pi process.

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

Run multiple agents in parallel with a shared thinking level and one per-task override:

```json
{
  "tasks": [
    {
      "agent": "scout",
      "task": "Map package metadata files",
      "timeoutMs": 30000,
      "thinkingLevel": "low"
    },
    {
      "agent": "reviewer",
      "task": "Review TypeScript config consistency"
    }
  ],
  "timeoutMs": 120000,
  "thinkingLevel": "medium"
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

## 🔁 Stateful agents

Stateful agents are an opt-in logical-session layer over the same isolated one-shot Pi subprocesses. Each turn starts a fresh child process; the extension retains only sanitized, bounded task/output history and supplies it to the next turn. This avoids relying on an undocumented bidirectional child protocol.

Enable the lifecycle tools in `~/.pi/agent/pi-subagents-config.json`, then reload Pi:

```json
{
  "stateful": {
    "enabled": true,
    "maxAgents": 16,
    "maxActiveTurns": 4,
    "maxDepth": 3,
    "maxChildrenPerAgent": 8,
    "maxMailboxMessages": 100,
    "maxMailboxMessageBytes": 16384,
    "idleTtlMs": 3600000,
    "retentionDays": 30,
    "maxStoredAgents": 50
  }
}
```

Enabling the feature registers:

| Tool | Purpose |
| --- | --- |
| `subagent_spawn` | Start a logical agent and return an opaque `agentId`. |
| `subagent_send` | Send follow-up work to a reusable agent. |
| `subagent_message` | Queue a bounded mailbox message without starting a turn; sender IDs must be `root` or an agent in the same tree. |
| `subagent_messages` | Read and optionally acknowledge unread mailbox messages. |
| `subagent_wait` | Wait for completion without terminating the agent on wait timeout. |
| `subagent_list` | List retained agents and lifecycle states. |
| `subagent_interrupt` | Abort the current turn while retaining its identity and history. |
| `subagent_close` | Abort if necessary, close the agent, and remove it from retained persistence. |

Use `/subagents:agents list` to inspect the indented agent tree, lifecycle state, unread count, and available actions. Use `/subagents:agents clear` to close and delete all retained agents for the session. Active turns are FIFO-limited by `maxActiveTurns`; excess retained work remains in `starting` state until a slot is available. `maxAgents` separately bounds running, queued, and idle records. `parentId` creates a bounded child relationship; subtree interrupt and close operate child-first.

`subagent_spawn.context` accepts:

- `"none"` (default) — no parent conversation.
- `"all"` — bounded user/assistant text from the active branch.
- `"summary"` — a bounded earlier-context checkpoint plus recent messages verbatim.
- A positive number — the most recent N user turns and related assistant text.

Use `contextEntryIds` to select exact session entries. Stable source IDs are retained so repeated follow-ups do not need to duplicate parent context.

Reasoning, tool results, custom transport messages, and non-text parts are excluded. Text inside `<private>...</private>` and lines containing `[subagent-private]` are omitted before context, mailbox content, or history is persisted.

Stateful execution now uses a transport boundary. `SubprocessTransport` is the supported fallback and preserves current behavior; a native child-session transport remains unavailable until Pi exposes supported child-session APIs. No private Pi imports are used.

Write-capable agents share the workspace by default. Concurrent write-capable starts in the same cwd are rejected unless `allowConcurrentWrites` is explicitly set. Set `workspaceMode: "worktree"` to opt into a disposable detached Git worktree; this requires a clean repository and the worktree is removed on close or session shutdown. Isolated worktree agents are intentionally not restored after shutdown.

## 📜 Compatibility and failure contract

Existing `subagent` requests remain unchanged:

| Mode | Ordering | Failure behavior |
| --- | --- | --- |
| Single | One result. | A failed/aborted/timed-out worker is marked as a tool error while preserving bounded details. |
| Chain | Input order. | Stops at the first failed step; completed steps remain in details. |
| Parallel | Input order, with at most four active children. | Collects all task results; partial worker failure is reported in summaries but does not discard successful results. |
| Parallel + aggregator | Source input order, then aggregator. | The aggregator runs with both successful outputs and failure descriptions; aggregator failure marks the tool result as an error. |

Timeout precedence remains: task/step/aggregator → call → agent setting → `PI_SUBAGENT_TIMEOUT_MS` → 600000 ms. Thinking precedence remains: task/step/aggregator → call → agent setting → child default. Project-agent resolution and confirmation behavior is unchanged.

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
thinkingLevel: high
---

You are an API review subagent. Do not edit files. Check compatibility,
test coverage, and migration risks. Report PASS/FAIL/PARTIAL with evidence.
```

By default, `subagent` loads user agents only. Set `agentScope` to `"project"` or `"both"` to load project-local agents. Interactive sessions ask for confirmation before using project agents unless `confirmProjectAgents` is disabled.

## ⏱️ Runtime limits and thinking levels

Each subprocess has a hard timeout to avoid runaway workers.

- Set `timeoutMs` on the top-level call to apply a default for all jobs.
- Set `timeoutMs` on a task, chain step, or aggregator to override it locally.
- If omitted, the default is `PI_SUBAGENT_TIMEOUT_MS`, or `600000` milliseconds (10 minutes) when unset.

Set `thinkingLevel` to pass Pi's `--thinking <level>` to a subprocess. Supported values are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`.

Thinking-level precedence is: task/chain step/aggregator `thinkingLevel` → top-level `thinkingLevel` → agent default from config or frontmatter → Pi subprocess default. Omit `thinkingLevel` to preserve existing behavior. Pi still owns model capability clamping, so unsupported thinking levels are handled by the spawned Pi process.

On timeout, the extension sends process-group `SIGTERM`, escalates to `SIGKILL` after a five-second grace period if the process has not actually closed, and returns partial bounded messages or stderr collected so far. Parent abort uses the same cleanup path and preserves a structured result.

The child event protocol limits each JSON line to 256 KiB. Captured output uses these defaults:

- final output and fan-in/chain context: 50 KiB;
- stderr: 16 KiB;
- captured messages: 200.

Truncated text includes a `truncated by pi-subagents` marker and details expose `truncated: true`. `PI_SUBAGENT_MAX_DEPTH` controls nested delegation depth and defaults to 1; child processes receive `PI_SUBAGENT_DEPTH` automatically.

## 📡 Runtime status

While the `subagent` tool is running, `pi-subagents` publishes compact activity status with `ctx.ui.setStatus("subagents", "...")`. Any statusline extension that reads Pi's generic extension status API can display it; no package-to-package dependency is required.

## 🔒 Safety notes

Subagents have separate processes and context windows, but they are **not security sandboxes**. They run as the same OS user, share the host filesystem and network access, and may conflict if they edit the same files. Tool allow-lists reduce available Pi tools but do not reduce operating-system permissions.

The runner explicitly reports policy continuity in result details:

- inherited: process environment;
- overridden when selected: cwd, model, thinking level, and tool list;
- unsupported guarantees: parent approval policy, sandbox profile, and provider headers.

Treat project-local agent prompts like executable project configuration: only enable them in trusted repositories. Stateful project agents require Pi's project trust; interactive use also keeps confirmation enabled by default.

Stateful records are stored as versioned mode-0600 JSON under `~/.pi/agent/pi-subagents-state/` (or the configured Pi agent directory). Records contain sanitized logical history, never process IDs or credentials. Corrupt or unsupported state is quarantined, restored agents are always inert `idle` records, and no prior side effect is automatically resumed. Retention and count limits are configurable. Downgrading is safe: older extension versions ignore this separate state directory; use `/subagents:agents clear` before downgrade if the histories should be removed.

## 🗂️ Package layout

```txt
extensions/pi-subagents/
├── src/
│   ├── subagents.ts  # Pi entrypoint and tool schema
│   └── *.ts          # Package-local discovery, execution, rendering, and config modules
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

Only `subagents.ts` is a Pi entrypoint; the other source modules are internal. The package exposes its Pi extension through `package.json`:

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
