# 🧑‍🤝‍🧑 pi-subagents — Isolated Subagents for the Pi Coding Agent

[![npm](https://img.shields.io/npm/v/@narumitw/pi-subagents)](https://www.npmjs.com/package/@narumitw/pi-subagents) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-subagents` is a native [Pi coding agent](https://pi.dev) extension for delegating work to specialized agents. The batch `subagent` tool keeps isolated Pi subprocesses, while addressable lifecycle tools can run reusable agents either as subprocess-backed logical sessions or as public-SDK in-process child sessions.

Use it to split independent research, planning, implementation, and review work across focused workers. Background delegation is intended for sidecar work the main agent can overlap with useful local work—not for handing off one critical-path task and waiting.

## ✨ Features

- Registers a `subagent` tool for single-agent, parallel, fan-in, and chained delegation.
- Keeps batch workers isolated in `pi --mode json -p --no-session` subprocesses.
- Registers detached stateful lifecycle tools by default; completion can stay queued for the next turn or opt into an idle root synthesis turn.
- Supports an opt-in public-SDK `in-process` stateful transport with one reusable child `AgentSession` per `agentId`.
- Supports built-in `scout`, `planner`, `reviewer`, and `worker` agents.
- Loads custom user agents from `~/.pi/agent/agents/*.md`.
- Optionally loads project agents from `.pi/agents/*.md` with confirmation.
- Provides `/subagents settings|status|help` for completion delivery plus `/subagents:config` for per-agent tool allow-lists.
- Supports per-task `cwd`, hard subprocess `timeoutMs`, `thinkingLevel`, abort propagation, and streaming progress.
- Bounds JSON lines, captured messages, stderr, final output, chain substitution, and fan-in context.
- Enforces a recursion-depth guard and deterministic process-group termination.
- Provides addressable stateful agents with follow-up, mailbox, list, interrupt, close, context selection, and persistence.
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

`pi-subagents` registers a primary batch tool plus the stateful lifecycle tools documented below:

- `subagent` — delegate blocking single, parallel, fan-in, or chained batch work. The main agent cannot process queued steering until the call returns.
- `subagent_spawn` and related lifecycle tools — start reusable detached work, return immediately, and receive bounded completion messages automatically.

Choose the API by lifecycle:

| Need | Use |
| --- | --- |
| A result is required before the root's next action, and blocking user steering is intentional | One blocking `subagent` call (`tasks` for synchronous parallel work) |
| Broad asynchronous research/review that can overlap root work | Prefer one `subagent_spawn` covering related branches |
| Reusable history, follow-ups, or mailboxes | `subagent_spawn` and lifecycle tools |
| One simple or critical-path action the root can perform directly | No subagent |

Execution modes:

- **single** — run one `{ agent, task }` job.
- **parallel** — run multiple `{ agent, task }` jobs independently.
- **parallel + aggregator** — run parallel jobs, then pass all outputs into one fan-in agent.
- **chain** — run sequential steps, passing prior output with `{previous}`.

Common controls:

- `cwd` — run a job from a different working directory.
- `timeoutMs` — set a hard subprocess timeout.
- `thinkingLevel` — request `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` thinking for the spawned Pi process.

## 🧭 Proactive use

The `subagent` tool advertises concise prompt guidance so the main Pi agent can decide
whether to spawn 0, 1, or multiple subagents without an explicit user-specified count.

Count-selection guidance:

- Use **no subagent** for simple answers, quick targeted edits, latency-sensitive one-step work, or
  tasks that need frequent user back-and-forth.
- `subagent` is deliberately blocking: while it runs, the main agent cannot answer queued steering.
  Use it only when the outputs are required before the next root action and waiting is intentional.
- For broad research or review, prefer **one detached `subagent_spawn`** whose task covers related
  branches even when the final answer depends on its result. Do not choose blocking parallel fan-out
  merely to keep delegation in one turn. Add another detached agent only when the work is truly
  independent and shared-workspace concurrency is safe.
- Use detached `subagent_spawn` only for a concrete bounded subtask that can run independently
  alongside useful main-agent work and when bounded context/output, independent review, a distinct
  model/tool profile, or workspace isolation provides concrete value. After spawning, do useful
  non-overlapping work immediately. If none remains, briefly tell the user what was launched and end
  the response. Do not poll lifecycle tools for progress or duplicate the delegated work.
- If synchronous parallel or fan-in output is genuinely required, keep blocking `subagent` tasks
  independent, stay within the hard max of 8, and do not parallelize implementation that may edit
  the same files or shared state.
- Do not use project-local agents unless the user explicitly opts into them with
  `agentScope: "project"` or `"both"`; keep confirmation enabled for untrusted repositories.

Examples where the main agent chooses the count:

No subagent for a known-file edit:

```txt
Rename one symbol in src/foo.ts.
```

One detached agent for a broad asynchronous review (call `subagent_spawn`):

```json
{
  "agent": "reviewer",
  "task": "Review source, tests, and integration risks for the current changes. Do not edit files. Report PASS/FAIL/PARTIAL with evidence."
}
```

A blocking fan-out is reserved for output that must be synthesized before the root continues (call
`subagent`):

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
    }
  ],
  "aggregator": {
    "agent": "reviewer",
    "task": "Merge these findings into a concise implementation-risk summary. Use {previous}."
  }
}
```

## 🚀 Blocking batch examples

Every example in this section calls `subagent` and keeps the main agent unavailable until the batch
finishes. Use `subagent_spawn` instead when the work can complete asynchronously.

Run one read-only reconnaissance agent:

```json
{
  "agent": "scout",
  "task": "Find the statusline extension entry points"
}
```

For genuinely random values, specify the range, duplicate policy, and a system randomness source instead of relying on model sampling, for example: `Use Python secrets to return 10 integers from 0 through 999; duplicates are allowed.`

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

Stateful lifecycle tools are available by default. `subagent_spawn` is detached: it schedules work, returns immediately with an opaque `agentId`, and later injects a bounded `pi-subagent-completion` custom message. Completions that settle in the same dispatch window are batched, and the broker allows at most one in-flight root wake until that parent turn starts.

Detached work follows a non-polling policy: prefer one bounded `subagent_spawn` that covers related asynchronous research or review even when the final answer depends on its result, then do useful non-overlapping main-agent work immediately. If none remains, briefly tell the user what was launched and end the response. Do not poll `subagent_list` or `subagent_messages` for progress, and do not duplicate the delegated work. Add another detached agent only for truly independent work with safe workspace concurrency. The blocking `subagent` batch tool remains available when results are genuinely needed before the root can continue and delaying queued steering is intentional; detached lifecycle work intentionally has no `subagent_wait` tool.

A detached agent additionally needs a concrete isolation or specialization benefit such as independent review, bounded context/output, a distinct model/tool profile, or workspace isolation. Simple work that the main agent can perform directly should not be delegated.

`stateful.completionDelivery` controls settled completion delivery:

- `"next-turn"` (default) preserves the previous behavior: use `deliverAs: "steer"` with `triggerTurn: false`. An active root can consume completion naturally; an idle root is not awakened.
- `"auto-resume"` holds completion while the root is active, then requests one synthesis turn after the parent settles when no user or extension messages are already pending. Simultaneous completions share that turn, active work is not interrupted, and pending input suppresses the autonomous wake.

Auto-resume is best-effort because Pi's custom-message API is fire-and-forget. Session-generation checks, shutdown cleanup, batching, and the in-flight wake guard prevent stale or duplicate scheduling pressure, but they do not make completion delivery durable across process exit.

The default `subprocess` transport preserves compatibility: each turn starts a fresh isolated `pi --mode json -p --no-session` child and receives sanitized, bounded history. Set `transport` to `in-process` to retain one public Pi SDK `AgentSession` per stateful `agentId`, avoiding repeated process startup while preserving native child history in memory.

Use `/subagents settings` to change completion delivery interactively and apply it immediately. `/subagents status` shows configured versus runtime values, source, and path; `/subagents help` summarizes the commands. Manual edits use `~/.pi/agent/pi-subagents.json` and take effect after reloading Pi:

```json
{
  "stateful": {
    "transport": "in-process",
    "completionDelivery": "auto-resume",
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

The settings UI patches the raw JSON atomically and preserves unknown fields; it refuses to overwrite malformed or invalid settings. Set `"enabled": false` to remove all stateful lifecycle tools. Otherwise, the extension registers:

| Tool | Purpose |
| --- | --- |
| `subagent_spawn` | Start detached work, return an opaque `agentId` immediately, and deliver completion asynchronously. |
| `subagent_send` | Send follow-up work to a reusable agent; shared-workspace write conflicts are guarded unless explicitly overridden. |
| `subagent_message` | Queue a bounded mailbox message without starting a turn; sender IDs must be `root` or an agent in the same tree. |
| `subagent_messages` | Read and optionally acknowledge unread mailbox messages. |
| `subagent_list` | List retained agents and lifecycle states. |
| `subagent_interrupt` | Abort the current turn while retaining its identity and history. |
| `subagent_close` | Abort if necessary, close the agent, and remove it from retained persistence. |

Use `/subagents:agents list` to inspect the indented agent tree, lifecycle state, unread count, and available actions. Use `/subagents:agents clear` to close and delete all retained agents for the session. Active turns are FIFO-limited by `maxActiveTurns`; excess retained work remains in `starting` state until a slot is available. `maxAgents` separately bounds running, queued, and idle records. `parentId` creates a bounded child relationship; subtree interrupt and close operate child-first.

`subagent_spawn.context` accepts:

- `"none"` (default) — no parent conversation.
- `"all"` — bounded user/assistant text from the active branch.
- `"summary"` — a bounded earlier-context checkpoint plus recent messages verbatim.
- A positive number — the most recent N user turns and related assistant text.

Use `contextEntryIds` to select exact session entries. Supplying IDs without `context` implies `context: "all"`; an explicit `context: "none"` still disables parent context. Stable source IDs are retained so repeated follow-ups do not need to duplicate parent context.

Reasoning, tool results, custom transport messages, and non-text parts are excluded. Text inside `<private>...</private>` and lines containing `[subagent-private]` are omitted before context, mailbox content, or history is persisted.

Stateful execution uses a transport boundary:

- `subprocess` is the default compatibility and rollback path.
- `in-process` uses only public Pi SDK APIs: `createAgentSession()`, `SessionManager.inMemory()`, `DefaultResourceLoader`, and normal session lifecycle methods. It isolates conversation/tool selection, not memory or crashes; child failures share the parent Node.js process.
- Child resource loading sets `noExtensions: true`, preventing recursive `pi-subagents` loading and duplicate extension side effects while retaining normal context/skill resources and the selected agent prompt.
- Agent model, thinking level, and built-in tool allow-list overrides are applied when the child is created. Parent model/thinking changes are snapshotted for subsequently created children; an existing child keeps its own session configuration.
- Extension/custom tool names are rejected in-process with an actionable recommendation to use `subprocess`; permissions are never silently widened.
- Timeout, parent abort, close, expiry, and session shutdown abort/dispose owned child sessions. A child that does not settle after abort grace is discarded rather than reused.
- In-process startup failures do not silently retry through subprocesses, preventing duplicate side effects.

No private Pi imports, runtime casts, or `ExtensionAPI` monkey-patching are used. Approval policy, sandbox profile, provider-header hooks, extension state, global scheduling, and parent/child transcript switching are not inherited or provided by the in-process transport.

Write-capable agents share the workspace by default. Concurrent write-capable starts in the same cwd are rejected unless `allowConcurrentWrites` is explicitly set. Classification is intentionally conservative: an agent with `bash`, `write`, or `edit` is write-capable even when its task prompt says “read only,” because prompt wording is not a filesystem sandbox. Prefer one detached agent when asynchronous work can be combined. If concurrent work is genuinely required, use the blocking batch only when synchronous outputs justify making the root unavailable, explicitly accept safe detached overlap with `allowConcurrentWrites`, or use isolated worktrees when repository isolation is needed.

Set `workspaceMode: "worktree"` to opt into a disposable detached Git worktree; this requires a clean repository and the worktree is removed on close or session shutdown. Isolated worktree agents are intentionally not restored after shutdown.

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
| `reviewer` | Independent review of code and existing verification evidence. | `read`, `grep`, `find`, `ls`, `bash` |
| `worker` | General-purpose implementation. | Pi default tools |
| `general`, `general-purpose` | Aliases for `worker`. | Pi default tools |

The built-in `reviewer` does not run tests, builds, benchmarks, or formatters. It recommends additional verification commands for the main agent to run instead. Custom agents can override this behavior.

Built-in agents inherit the active/default Pi model instead of forcing a provider-specific model alias, which keeps subprocesses usable across different Pi setups.

## ⚙️ Configure agent tools

Run `/subagents:config` in an interactive Pi session to edit the tools each subagent may use.
The command stores settings in `~/.pi/agent/pi-subagents.json`.

Compatibility: a valid legacy `pi-subagents-config.json` is migrated automatically to `pi-subagents.json`. If both files exist, the new filename takes precedence.

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

`agentScope` is a top-level tool argument supplied per invocation. It is not a setting in
`~/.pi/agent/pi-subagents.json` and does not belong in agent frontmatter. The scope selects which
custom agent directories are loaded; built-in agents remain available in every scope:

| `agentScope` | Custom agents loaded |
| --- | --- |
| `"user"` (default) | User agents only. |
| `"project"` | Project-local agents only. |
| `"both"` | User and project-local agents. Project definitions override same-named user definitions. |

For example, invoke a project-local agent with the blocking `subagent` tool:

```json
{
  "agent": "api-reviewer",
  "task": "Review this project's API changes",
  "agentScope": "project"
}
```

Or select the scope when creating a stateful agent with `subagent_spawn`:

```json
{
  "agent": "api-reviewer",
  "task": "Review this project's API changes",
  "agentScope": "project"
}
```

A stateful agent retains the scope selected by `subagent_spawn` for its follow-ups. Every new
blocking `subagent` invocation or `subagent_spawn` call that needs project agents must supply
`agentScope: "project"` or `"both"` again.

Project-local agents require a trusted Pi project. Interactive sessions also ask for confirmation
before using them by default. Passing `confirmProjectAgents: false` as another top-level tool
argument skips that confirmation dialog, but it does not bypass the project trust requirement.

## ⏱️ Runtime limits and thinking levels

Each subprocess has a hard timeout to avoid runaway workers.

- Set `timeoutMs` on the top-level call to apply a default for all jobs.
- Set `timeoutMs` on a task, chain step, or aggregator to override it locally.
- If omitted, the default is `PI_SUBAGENT_TIMEOUT_MS`, or `600000` milliseconds (10 minutes) when unset.

Set `thinkingLevel` to pass Pi's `--thinking <level>` to a subprocess. Supported values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

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
