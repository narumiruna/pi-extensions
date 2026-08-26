# 🧩 Pi Subagents v3 — Minimal Bounded Job Primitives

[![npm](https://img.shields.io/npm/v/@narumitw/pi-subagents-v3)](https://www.npmjs.com/package/@narumitw/pi-subagents-v3) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

> [!WARNING]
> Pi Subagents v3 is experimental.
> Its job lifecycle and completion format may change between releases.

Pi Subagents v3 provides only the runtime primitives needed to start, inspect, cancel, wait for, and synchronously consult bounded subagent jobs.

A bundled `subagents-v3` skill owns delegation strategy, parallel-work guidance, timeout selection, result handling, verification, and writer safety.

## ✨ Features

- Starts one isolated Pi child process per bounded background job.
- Publishes one guarded asynchronous completion and releases child resources at terminal state.
- Exposes bounded agent and job metadata without returning task text or complete output from inspection.
- Makes cancellation idempotent and keeps wait timeouts independent from execution deadlines.
- Runs synchronous consultations with only Pi's read-only `read`, `grep`, `find`, and `ls` tools.
- Cancels active session-owned work during replacement, reload, or shutdown.

## 📦 Install

Install persistently after the package is published:

```bash
pi install npm:@narumitw/pi-subagents-v3
```

Try from npm without installing permanently:

```bash
pi -e npm:@narumitw/pi-subagents-v3
```

Try the extension and bundled skill from a local checkout:

```bash
pi --no-extensions -e ./packages/pi-subagents-v3
```

The package uses its source entrypoint and does not require a build before local loading.

Pi extensions and writable child agents execute with your user permissions.

Review source and agent definitions before installing or invoking them.

## 🚀 Quick start

Ask Pi to use the bundled `subagents-v3` skill when deciding whether to delegate.

A typical background flow starts a job, continues useful main-agent work, and consumes the asynchronous completion without polling.

Use `subagent-v3-wait` only when that result becomes necessary for the next action.

## 🛠️ Tools

| Tool | Parameters | Purpose |
| --- | --- | --- |
| `subagent-v3-start` | `agent`, `task`, optional `timeout` | Start one background job and return its `jobId` immediately. |
| `subagent-v3-inspect` | none | List bounded available-agent and retained-job metadata. |
| `subagent-v3-cancel` | `jobId` | Idempotently cancel one queued or running job. |
| `subagent-v3-wait` | `jobId`, optional `timeout` | Wait for one job without cancelling it. |
| `subagent-v3-consult` | `agent`, `task`, optional `timeout` | Run one synchronous ephemeral read-only consultation. |

Execution timeouts use seconds, accept finite numbers greater than zero through 2,147,483.647, and have no default.

Omitting `timeout` lets the child run until it exits, is cancelled, the session shuts down, or the Pi process exits.

Wait timeouts use the same optional seconds format and have no default.

Omitting `timeout` from `subagent-v3-wait` waits until the job becomes terminal or the caller cancels the wait.

Tasks are limited to 50 KiB of UTF-8 text.

The terminal states are `completed`, `partial`, `failed`, `timed_out`, and `cancelled`.

`subagent-v3-inspect` never returns complete task text, child output, prompts, context, credentials, environment variables, or secrets.

## 🤖 Agent definitions

The extension includes `explorer` and `worker` agents.

It also discovers user definitions from `<getAgentDir()>/agents/*.md` and trusted-project definitions from the nearest `.pi/agents/*.md` directory.

Trusted project definitions override same-name user or built-in definitions, and user definitions override same-name built-ins.

A minimal definition is:

```markdown
---
name: reviewer
description: Review code correctness and risks.
tools: read, grep, find, ls
thinkingLevel: low
---

Review the bounded task and cite exact evidence.
```

Optional `model`, `thinkingLevel`, and `tools` frontmatter customize child execution.

Project definitions are ignored until Pi reports the project as trusted.

## 🔄 Lifecycle and retention

A new job starts as `queued`, transitions to `running`, and reaches exactly one terminal state.

The runtime retains up to 32 recent terminal records for up to 24 hours within the current extension session.

Inspection reports older records removed by retention bounds through `omitted.jobs`.

Cancelling a job terminalizes the attempt before signalling its child, so stale late output cannot replace the cancelled state.

Session replacement and shutdown cancel active work, suppress stale completion delivery, and wait for child cleanup.

## 🔒 Security and privacy

Normal background jobs use the selected agent's tools and run in the current working directory.

Writable agents can modify the shared working tree and run commands with the Pi process environment and user permissions.

A read-only consultation disables extensions, shell and write tools, prompt templates, skills, and session persistence in its child.

Read-only tool enforcement is not a filesystem sandbox because the allowed read tools can inspect files available to the user account.

Tasks, repository context, and inspected file content may be sent to the selected model provider.

Parallel writers require disjoint ownership or workspace isolation outside this extension.

## 🚧 Limitations

The extension does not provide retained conversations, follow-up turns, peer mailboxes, Agent Teams, chains, fan-in aggregators, panels, workflow DAGs, dynamic scheduling, verification orchestration, nested subagents, or extension-owned semantic memory.

The main agent must verify worker claims against the actual diff and deterministic checks.

Asynchronous completions do not wake an idle model turn automatically.

Jobs and their retained results do not survive extension reload, session replacement, or process exit.

## 🗂️ Package layout

```text
packages/pi-subagents-v3/
├── docs/                        # Concise tools and parameters reference
├── src/                         # Extension, registry, discovery, and subprocess runtime
├── skills/subagents-v3/        # Delegation operating manual
├── test/                        # Focused lifecycle and policy tests
├── package.json                 # Pi extension and skill declarations
└── README.md                    # User guide and safety boundaries
```

## 🔎 Keywords

Pi, subagents, agents, delegation, background jobs, read-only consultation, cancellation, bounded execution.

## 📄 License

[MIT](./LICENSE)
