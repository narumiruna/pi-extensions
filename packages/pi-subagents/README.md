# 🧩 Pi Subagents — Subagent Jobs with Main-Agent Messaging

[![npm](https://img.shields.io/npm/v/@narumitw/pi-subagents)](https://www.npmjs.com/package/@narumitw/pi-subagents) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Pi Subagents runs Pi jobs in separate child processes and supports authenticated request-response messaging in both directions while each job is active.

## ✨ Features

- Runs each job in an isolated Pi child process and returns its job ID immediately.
- Uses the task to define the child's specialization and explicit tools, skills, and extensions to define its capabilities.
- Defaults work tools to `read`, `grep`, `find`, and `ls`.
- Can attach validated local skills and trusted local extensions to one job without enabling automatic discovery.
- Verifies requested extension tools before sending the task to the child model.
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

In TUI mode, the above-editor widget shows each queued or running job's ID, state, elapsed time, timeout, and selected core and extension tool names.
It omits fixed communication tools, attachment paths, and resource totals, disappears when no jobs remain active, and clears when the session ends.

## 🛠️ Tools

The main Pi session exposes five fixed tools:

| Tool | Parameters | Purpose |
| --- | --- | --- |
| `subagent_spawn` | `task`, optional `tools`, `skills`, `extensions`, `thinkingLevel`, `timeout` | Start one subagent job and return its `jobId`. |
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
`subagent_inspect` never returns complete task text, child output, prompts, selected tools, attachment paths or totals, context, credentials, environment variables, requests, responses, or secrets.

See [`docs/tools.md`](./docs/tools.md) for the concise schema reference, [`docs/attachments.md`](./docs/attachments.md) for attachment validation, and [`docs/messaging.md`](./docs/messaging.md) for messaging behavior.

## ⚙️ Job configuration

The task should state the child's role, objective, scope, constraints, and expected result.
For reusable delegation policy, you can create your own project skill under `.pi/skills/<your-skill>/SKILL.md` or global skill under `~/.pi/agent/skills/<your-skill>/SKILL.md`.
Choose its name, trigger, tool policy, task format, and verification workflow for your use case.
The package intentionally registers and publishes no skill; the repository-only [`using-pi-subagents` example](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-subagents/skills/using-pi-subagents) is an optional starting point.

`subagent_spawn` accepts this additive configuration:

```ts
{
  task: string;
  tools?: Array<"read" | "bash" | "powershell" | "edit" | "write" | "grep" | "find" | "ls">;
  skills?: string[];
  extensions?: Array<{ path: string; tools: string[] }>;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  timeout?: number;
}
```

The optional `tools` list selects Pi core work tools.
Omitting it selects `read`, `grep`, `find`, and `ls`, while an empty list gives the child no core work tools.
The runtime always adds `subagent_send` and child `subagent_wait` and removes duplicate names.
Adding `edit` or `write` lets the child modify files, while `bash` or `powershell` grants unrestricted command execution.

The optional `skills` list attaches local Pi skills through progressive disclosure without injecting their full bodies or adding tools.
Every attached skill path must contain at least one loadable skill, every non-ignored declared skill must load successfully, and skill names must be unique across attachments.

Each `extensions` entry loads a trusted local extension file or directory and selects its initial extension tools.
An empty `tools` list loads provider or lifecycle behavior without initially exposing extension tools.
The parent checks that each requested tool comes from its specified attachment before the child model receives the task.
Attached extensions run with the child's user permissions and are not a sandbox.

Attachments must be existing local paths, not npm, Git, or URL sources.
Project-local attachments and resources resolved from their packages require project trust, including paths that symlink into the project.
A job accepts up to 16 skill paths, 16 extension entries, and 64 selected work tools.
The child inherits the main agent's effective model and thinking level by default; there is no per-job model override.
Parent-only extension providers require an attached extension that registers them in the child.
Process-local runtime API keys, including a parent-only `--api-key`, are unavailable to the child; use stored or inherited environment credentials.

See [Attachment behavior](./docs/attachments.md) for detailed path checks, package preflight, tool ownership, and resource limits.

## 🔄 Messaging, lifecycle, and retention

A main-originated request to a queued job waits for Pi RPC readiness before delivery. After delivery starts, cancellation stops only the caller's wait; the request may still arrive. An interrupted child-originated request remains active and can be waited on again.

The first accepted `subagent_send` response wins; repeated responses do not replace it. The execution timeout starts only after Pi accepts the RPC prompt. Jobs reach exactly one terminal state, and inspection retains up to 32 terminal records for up to 24 hours within the current session.

The broker uses loopback connections and per-job credentials passed through a private pipe, not the child's initial environment or command line. Cancelling a job or replacing the session revokes those credentials, stops pending work, and prevents stale completion delivery.

See [Messaging and lifecycle](./docs/messaging.md) for delivery, retry, retention, and shutdown details.

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

Every child disables session persistence and automatic discovery of extensions, skills, and prompt templates.
Only the communication bridge and explicitly attached resources are added back for that job.
Provider selection supports Pi's child-visible built-in and configured providers plus providers registered by an attached extension.
Credentials must be available independently to the child through Pi's stored credentials or inherited environment.

The broker accepts only loopback TCP connections with an active per-job token.
The token is bootstrapped through a private inherited pipe and is absent from the child's initial environment and command line.

A child request or response is visible main-agent model context, but its envelope explicitly identifies it as untrusted subagent content rather than user authorization.
A child message cannot grant permission for writes, shell commands, credential access, or other privileged actions.
A main-agent request is visible child model context, but it cannot expand the child's selected tools or grant capabilities the child did not receive at spawn time.

An attached skill contributes model instructions and may direct already selected tools to bundled helpers.
An attached extension is fully privileged executable code with the child process's user permissions, can run during factory and lifecycle hooks, can alter prompts or tool behavior, and can change active tools after startup.
Its requested tool list controls the initial provider-visible loadout but is not an operating-system sandbox.
Canonical attachment paths are passed to Pi in the child command line, but parent-generated inspection, completion, and broker metadata omit them and child diagnostic errors redact requested attachment roots before publication.
Attached code and model output remain untrusted and can disclose paths they can access, so attach only code you trust.

Terminal controls and bidirectional controls are stripped before untrusted child text is displayed.
Tasks, repository context, requests, responses, and inspected file content may be sent to the selected model provider.
Parallel writers require disjoint ownership or workspace isolation outside this extension.

## 🚧 Limitations

- Attachments must be existing local files or directories; package, Git, URL, and automatic parent-resource inheritance are unsupported.
- An attached extension may recreate a parent-registered provider, but parent in-memory extension state and runtime-only API keys are not forwarded.
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
├── dist/                              # Generated Jiti runtime, child bridge, and readiness probe
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
