# 🧩 Pi Subagents — Subagent Jobs with Main-Agent Messaging

[![npm](https://img.shields.io/npm/v/@narumitw/pi-subagents)](https://www.npmjs.com/package/@narumitw/pi-subagents) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Pi Subagents runs Pi jobs in separate child processes and supports authenticated request-response messaging in both directions while each job is active.

## ✨ Features

- Runs each job in an isolated Pi child process and returns its job ID immediately.
- Uses the task to define the child's specialization and the tool list to limit its capabilities.
- Defaults work tools to `read`, `grep`, `find`, and `ls`.
- Inherits the main agent's effective model and uses its thinking level by default.
- Gives the main agent and every child a context-specific `subagent_send` contract for bidirectional requests and responses.
- Gives every child `subagent_wait` for an answer to a child-originated request.
- Lets the main agent question a queued or running job through Pi RPC steering without retaining the child after completion.
- Publishes one asynchronous terminal completion and shows active-job progress above the editor.
- Exposes privacy-filtered metadata without task text, output, prompts, selected tools, or broker credentials.
- Cancels session-owned work and closes the broker during replacement, reload, or shutdown.

## 📦 Install

The version 3 runtime documented here is not yet published to npm.
The npm package still contains the legacy 2.x runtime and does not provide the tools below.

Install the repository source as one Pi package:

```bash
pi install git:github.com/narumiruna/pi-extensions
```

This Git installation enables every extension listed in the repository root manifest, including Pi Subagents.

To install only Pi Subagents, clone the repository, install dependencies, build its generated runtime, and install its package directory:

```bash
git clone https://github.com/narumiruna/pi-extensions.git
cd pi-extensions
npm install
npm --workspace @narumitw/pi-subagents run build
pi install ./packages/pi-subagents
```

Build before trying the extension from a local checkout:

```bash
npm --workspace @narumitw/pi-subagents run build
pi --no-extensions -e ./packages/pi-subagents
```

The package entry is generated at `dist/index.ts` and loaded through Pi's Jiti runtime.
An unbuilt local package directory cannot load its declared extension entry.

Pi extensions and children with `bash`, `powershell`, `edit`, or `write` execute with your user permissions.
Review the source before installing or invoking the extension.

## 🚀 Quick start

Call `subagent_spawn` with a self-contained task and only the work tools that task needs.

The call returns a `jobId` immediately, and the job continues in the background.
Continue useful main-agent work until the result is required or a completion arrives.

Use messaging only when needed:

- Call `subagent_send` with `recipient: jobId` to ask an active child a question.
- If `subagent_wait` returns `reason: "subagent_message"`, handle the visible request or response and wait for the job again only when needed.
- Answer a child-originated request by calling `subagent_send` with its `requestId`.

Completion messages follow Pi's global tool-output expansion state and the `app.tools.expand` binding (`Ctrl+O` by default).

In TUI mode, the above-editor widget shows each queued or running job's ID, state, elapsed time, timeout, and selected work tools.
The widget omits the fixed communication tools, disappears when no jobs remain active, and clears when the session ends.

## 🛠️ Tools

The main Pi session exposes five fixed tools:

| Tool | Parameters | Purpose |
| --- | --- | --- |
| `subagent_spawn` | `task`, optional `tools`, `thinkingLevel`, `timeout` | Start one subagent job and return its `jobId`. |
| `subagent_inspect` | none | List privacy-filtered retained-job metadata. |
| `subagent_cancel` | `jobId` | Idempotently cancel one queued or running job. |
| `subagent_wait` | `jobId`, optional `timeout` | Wait for a job or return early for an incoming child message. |
| `subagent_send` | `recipient` or `requestId`, plus `message` | Send a new request to an active child or answer one pending child request. |

Every child exposes these communication tools in addition to its selected work tools:

| Tool | Parameters | Purpose |
| --- | --- | --- |
| `subagent_send` | optional `requestId`, plus `message` | Omit `requestId` to send a new request to main, or provide it to answer one pending main-agent request. |
| `subagent_wait` | `requestId`, optional `timeout` | Wait for the main agent's plain-text response to a child-originated request. |

Main and child processes receive separate provider-visible `subagent_send` definitions for their own context:

- The main agent starts a request with an active job ID as `recipient` and omits `requestId`.
- The main agent answers a child request with `requestId` and omits `recipient`.
- A child starts a request to main by omitting `requestId`.
- A child answers a main-agent request by providing `requestId`.

Execution and wait timeouts use seconds, accept finite numbers greater than zero through 2,147,483.647, and have no default.
Omitting a job execution timeout lets the child run until it exits, is cancelled, the session shuts down, or the Pi process exits.
A wait timeout or caller cancellation stops only that wait and does not cancel its job or message request.
An incoming main-agent request interrupts an active child `subagent_wait` after RPC steering is queued so the child can receive the new request.
The interrupted child-originated request remains active and may be waited on again.

Tasks are limited to 50 KiB of UTF-8 text.
Requests and responses are limited to 48 KiB and 1,992 lines so their protocol envelopes fit Pi's 50 KiB and 2,000-line model-text bounds without truncating accepted content.
Each job may have up to four unresolved or answered-but-not-consumed requests across both directions.
The terminal states are `completed`, `partial`, `failed`, `timed_out`, and `cancelled`.
`subagent_inspect` never returns complete task text, child output, prompts, selected tools, context, credentials, environment variables, requests, responses, or secrets.

See [`docs/tools.md`](./docs/tools.md) for the concise schema reference.

## ⚙️ Job configuration

The task should state the child's role, objective, scope, constraints, and expected result.
For reusable delegation policy, you can create your own project skill under `.pi/skills/<your-skill>/SKILL.md` or global skill under `~/.pi/agent/skills/<your-skill>/SKILL.md`.
Choose its name, trigger, tool policy, task format, and verification workflow for your use case.
The package intentionally registers and publishes no skill; the repository-only [`using-pi-subagents` example](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-subagents/skills/using-pi-subagents) is an optional starting point.

The optional `tools` list limits what the child can do:

- Accepted names are `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`.
- Unavailable or extension-only tool names are rejected before a job is queued.
- Omitting `tools` selects `read`, `grep`, `find`, and `ls`.
- Passing an empty list gives the child no work tools.
- The runtime always adds `subagent_send` and child `subagent_wait` and removes duplicate names.

Adding `edit` or `write` lets the child modify files.
Adding `bash` or `powershell` grants unrestricted command execution and can also modify the workspace.

The optional `thinkingLevel` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
Omitting `thinkingLevel` captures the main agent's effective level when `subagent_spawn` executes.
The child inherits the main agent's effective provider and model when `subagent_spawn` executes.

Spawn rejects providers registered by a parent extension because child processes disable unrelated extensions.
Spawn also rejects process-local runtime API keys, including a parent-only `--api-key` value.
Use stored or environment credentials that child processes can read.
The extension does not expose a per-job model override.

## 🔄 Messaging, lifecycle, and retention

The session starts one TCP broker on `127.0.0.1` with an operating-system-assigned ephemeral port.
Each job receives one cryptographically random token bound to its job identity and session generation.
The parent passes the broker credentials once through a private inherited pipe instead of placing them in the child's initial environment or command line.
The child bridge reads and closes that descriptor before model tool execution.

Each child runs in Pi RPC mode so the parent can inject a main-originated request through `steer` after the initial prompt is accepted.
Each child broker call uses one request-scoped connection, while a response wait uses an abortable long poll.
A main-originated request to a queued job waits for RPC readiness before delivery is accepted.
After RPC accepts the steering message, the runtime interrupts active child response waits so the queued request can reach the child model.
Caller cancellation before RPC delivery starts rolls the request back.
Once RPC delivery starts, cancellation stops only the caller's wait; the request may still arrive and remains answerable until delivery fails or the job terminates.
The interrupted child-originated requests remain active and retryable.

The first accepted `subagent_send` response wins.
Repeated responses acknowledge the existing answer without replacing it.
A child may retry `subagent_wait` after a wait timeout because the underlying request remains active.

A new job starts as `queued`, transitions to `running`, and reaches exactly one terminal state.
The runtime retains up to 32 recent terminal records for up to 24 hours within the current extension session.
Inspection reports older records removed by retention bounds through `omitted.jobs`.
Cancelling or terminalizing a job revokes its token and rejects pending child waits before stale output can replace the terminal state.
Session replacement and shutdown cancel active work, suppress stale completion delivery, revoke credentials, close sockets, and stop the broker.

## 🔀 Migrating from 2.x

Version 3.0 replaces the previous orchestration runtime.
It does not migrate legacy settings, persisted jobs, retained conversations, or recovery state.
Finish or record any required work before upgrading, then start a fresh Pi session so stored calls do not request removed tool names.
Use these replacements where the new job model supports the previous intent:

| Previous interface | Version 3 interface |
| --- | --- |
| `subagent` or `subagent_spawn` | `subagent_spawn` |
| `subagent_await` | `subagent_wait` |
| `subagent_inspect` | `subagent_inspect` |
| `subagent_manage` cancellation | `subagent_cancel` |
| Child-to-main questions | Child `subagent_send` and `subagent_wait`, plus main `subagent_send` |
| Running main-to-child questions | Main and child `subagent_send` |

The version 3 `subagent_send` contracts are not compatible with the legacy retained-agent follow-up tool of the same name.
The `/subagents` command, extension settings, legacy retained follow-ups, `subagent_mailbox`, `subagent_consult`, custom agent catalogs, advanced orchestration, alternate transports, trust-aware cwd policy, and extension-owned worktrees have no direct replacement.
Describe the child's specialization in `task` and grant only the required work tools through `tools`.

## 🔒 Security and privacy

The selected work tools run in the current working directory.
The default list contains no shell or file-mutation tool.
It is not a filesystem sandbox because its read tools can inspect files available to the user account.
Selecting `bash`, `powershell`, `edit`, or `write` permits workspace mutation with the Pi process environment and user permissions.

Every child disables session persistence, unrelated extensions, skills, and prompt templates.
Provider selection therefore supports Pi's child-visible built-in and configured providers, not providers registered only by a parent extension.
Credentials must be available independently to the child through Pi's stored credentials or its inherited environment.

The broker accepts only loopback TCP connections with an active per-job token.
The token is bootstrapped through a private inherited pipe and is absent from the child's initial environment and command line.

A child request or response is visible main-agent model context, but its envelope explicitly identifies it as untrusted subagent content rather than user authorization.
A child message cannot grant permission for writes, shell commands, credential access, or other privileged actions.
A main-agent request is visible child model context, but it cannot expand the child's selected tools or grant capabilities the child did not receive at spawn time.

Terminal controls and bidirectional controls are stripped before untrusted child text is displayed.
Tasks, repository context, requests, responses, and inspected file content may be sent to the selected model provider.
Parallel writers require disjoint ownership or workspace isolation outside this extension.

## 🚧 Limitations

- The extension does not load arbitrary extension tools or parent-registered model providers in child processes.
- Process-local runtime API keys are not forwarded to children.
- The extension does not provide custom agents, per-job models, custom system prompts, peer-to-peer child messaging, retained conversations, user-directed follow-up work, mailboxes, Agent Teams, chains, fan-in aggregators, panels, workflow DAGs, dynamic scheduling, verification orchestration, nested subagents, or extension-owned semantic memory.
- Bidirectional messages use request-response coordination, not a retained conversational session.
- The main agent must verify child claims against the actual diff and deterministic checks.
- Child requests and responses trigger a main-agent turn, but asynchronous job completions do not wake an otherwise idle model turn automatically.
- Jobs, broker requests, and retained results do not survive extension reload, session replacement, or process exit.

## 🗂️ Package layout

```text
packages/pi-subagents/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── subagents.ts                   # Job, broker, and child lifecycle
├── dist/                              # Generated Jiti runtime and child bridge
├── scripts/build-runtime.mjs          # Runtime builder
├── docs/                              # Published reference documentation
├── skills/using-pi-subagents/         # Repository-only example; not published
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi, subagents, delegation, subagent jobs, least privilege, main-agent messaging, cancellation, job lifecycle.

## 📄 License

[MIT](./LICENSE)
