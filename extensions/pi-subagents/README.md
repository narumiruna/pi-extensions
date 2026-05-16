# @narumitw/pi-subagents

Delegate work from Pi to specialized subagents running in isolated `pi --mode json -p --no-session` subprocesses.

## Install

```bash
pi install npm:@narumitw/pi-subagents
```

Try locally from this repository:

```bash
pi -e ./extensions/pi-subagents
```

## What it adds

A `subagent` tool with three execution modes:

- **single**: run one `{ agent, task }`
- **parallel**: run multiple `{ agent, task }` jobs with bounded concurrency
- **parallel + aggregator**: run parallel jobs, then fan their complete outputs into one follow-up agent
- **chain**: run sequential steps, passing prior output with `{previous}`

The design borrows from Pi/Claude-style subagents: each worker has its own system prompt, tool boundary, optional model, subprocess context window, streaming progress, abort propagation, hard subprocess timeout, complete final output in tool details, and summarized sidechain result.

## Built-in agents

These are available without setup and can be overridden by user/project agents of the same name:

| Agent | Purpose | Tools |
| --- | --- | --- |
| `scout` | Read-only codebase reconnaissance | `read`, `grep`, `find`, `ls`, `bash` |
| `planner` | Grounded implementation plans | `read`, `grep`, `find`, `ls` |
| `reviewer` | Independent review and verification | `read`, `grep`, `find`, `ls`, `bash` |
| `worker` | General-purpose implementation | Pi default tools |
| `general`, `general-purpose` | Aliases for `worker` | Pi default tools |

Built-in agents intentionally inherit the active/default Pi model instead of forcing a model alias; this keeps subprocesses usable across provider setups.

## Custom agents

Create markdown files in:

- `~/.pi/agent/agents/*.md` for user agents
- `.pi/agents/*.md` for project agents

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

Project agents are repo-controlled and disabled by default. To allow them, set `agentScope` to `"project"` or `"both"`; interactive sessions ask for confirmation.

## Runtime limits

Each subagent subprocess has a hard timeout to avoid runaway workers. Set `timeoutMs` on the top-level call or per task/chain step. The default is `PI_SUBAGENT_TIMEOUT_MS`, or 600000ms (10 minutes) when unset. On timeout, the extension sends SIGTERM, escalates to SIGKILL after a short grace period, and returns any partial messages/stderr collected so far.

## Example tool calls

Single:

```json
{ "agent": "scout", "task": "Find the statusline extension entry points" }
```

Parallel:

```json
{
  "tasks": [
    { "agent": "scout", "task": "Map package metadata files", "timeoutMs": 30000 },
    { "agent": "reviewer", "task": "Review TypeScript config consistency" }
  ],
  "timeoutMs": 120000
}
```

Parallel with fan-in aggregation:

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

Chain:

```json
{
  "chain": [
    { "agent": "scout", "task": "Find subagent-related code" },
    { "agent": "planner", "task": "Using this context, plan the extension: {previous}" }
  ]
}
```

## Safety notes

Subagents are separate Pi processes and may use the tools allowed by their agent definition. Treat project-local agent prompts as code: only enable them in trusted repositories.
