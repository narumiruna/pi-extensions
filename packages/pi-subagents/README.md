# 🧩 Pi Subagents — Subagent Jobs with Main-Agent Messaging

[![npm](https://img.shields.io/npm/v/@narumitw/pi-subagents)](https://www.npmjs.com/package/@narumitw/pi-subagents) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Pi Subagents runs Pi jobs in separate child processes and supports authenticated request-response messaging in both directions while each job is active.

## ✨ Features

- Runs each job in an isolated Pi child process and returns its job ID immediately.
- Uses the task to define the child's specialization and explicit tools, skills, and extensions to define its capabilities.
- Defaults work tools to `read`, `grep`, `find`, and `ls`.
- Can attach validated local skills and trusted local extensions to one job without enabling automatic discovery.
- Verifies requested extension tools before sending the task to the child model.
- Supports exact per-job provider and model selection, with independent inheritance and no fallback.
- Gives the main agent and every child a context-specific `subagent_send` contract for bidirectional requests and responses.
- Gives every child `subagent_wait` for an answer to a child-originated request.
- Lets the main agent question a queued or running job through Pi RPC steering without retaining the child after completion.
- Publishes one asynchronous terminal completion and shows active-job progress above the editor.
- Provides a job manager with confirmed cancellation, immediate display settings, and session-local widget controls.
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

In TUI mode, the widget above the editor shows queued and running tasks; no new parameter is required.

Use messaging only when needed:

- Call `subagent_send` with `recipient: jobId` to ask an active child a question.
- If `subagent_wait` returns `reason: "subagent_message"`, handle the visible request or response and wait for the job again only when needed.
- Answer a child-originated request by calling `subagent_send` with its `requestId`.

Completion messages and child requests and responses follow Pi's global tool-output expansion state and the `app.tools.expand` binding (`Ctrl+O` by default).
Collapsed messages show a summary and the configured expansion key; expanded messages show the full content.
This display state does not change the content sent to the model.

## 💬 Commands

`/subagents` opens a manager for current-session job metadata, confirmed cancellation of active jobs, display settings, status, and help.
`/subagents settings` opens the same settings screen directly.
These are the only accepted routes; unknown arguments and trailing input are rejected.

The manager supports TUI and RPC modes. RPC uses dialogs and reports the settings file path instead of opening a settings editor.
Print and JSON modes reject these interactive commands with an error; the model tools remain available.
Job lists and details always show job IDs, regardless of widget preferences, and omit task text and child output.
Jobs do not survive reload or session replacement.

## 🖥️ Widget presentation

The widget is TUI-only and contains only queued or running jobs. Each row starts with `▶` for running or `○` for queued, followed by a task preview. Job IDs and tool names are hidden by default.
For example, with a main-agent thinking level of `high` at spawn:

```text
Subagents · 2 active
▶ Review widget tests · 12s
○ Audit settings · thinking: medium · queued
```

The `provider: <id>`, `model: <id>`, and `thinking: <level>` fields each appear only when the resolved value differs from the main agent's effective value captured at spawn, including an `off` thinking override. Inherited values and explicit values equal to those defaults are hidden. An explicit provider/model pair without a selected main-agent model shows both IDs.
Later main-agent changes do not change these comparisons. The fields describe the configuration passed at spawn, not child-side normalization or later changes.
Running rows show elapsed time and a timeout only when one is set. Queued rows show `queued` and a configured timeout, without elapsed time. **Show timing** controls both time fields.

The task preview removes terminal controls, collapses whitespace, and uses at most 40 terminal columns, including an ellipsis when shortened. It describes the assigned task, not live child activity; the full task sent to the child is unchanged.
Task text is visible in this local widget, but `subagent_inspect` continues to omit it. Optional tool names include selected core and extension tools, not fixed communication tools.
The widget omits attachment paths and resource totals, disappears when no jobs remain active, and clears when the session ends.

Ordinary updates refresh the mounted widget without changing its position among other widgets. Hiding and showing it again can change that position.
The widget uses at most ten rows, including one separator, and reserves eight terminal rows for the editor and footer. This is a local height limit, not a calculation of space left by other widgets.
With fewer than two available rows it renders nothing. Short layouts use a summary with active, running, queued, and omitted-row counts. Narrow layouts clip each line to the terminal width.

In `/subagents`, **Widget view** provides details, summary, hide/show, pin/unpin, automatic compaction, and item-view reset controls.
These controls are session-local and do not write settings. Manual hide remains in effect across job changes until you show the widget again.
A pin prevents automatic compaction, but does not override `showWidget: false`, width limits, or row limits. Unpinning does not immediately compact the view.
An explicit details, summary, or hide/show choice cancels the pending automatic rule.

Automatic compaction is off by default. Choose **Next consumed user message** to compact when Pi emits `message_start` for a user message, including extension-generated user messages and queued messages when consumed. Input submission, rejected input, and unconsumed queues do not count.
Choose **Next eligible settled cycle** to wait for `agent_settled` after later consumed user activity in that same cycle. The cycle already active when the rule is armed is excluded, including run preparation before `agent_start` and a cycle that started during settings loading.
Retries, tool turns, continuations, automatic context compaction, and batched queued messages can share one cycle. Tree navigation and manual context compaction are not response cycles.
Eligibility requires a non-aborted settlement and a latest observed turn outcome other than error or abort; a non-aborted settlement alone is insufficient.
A pending rule rearms on meaningful active-job changes, but not elapsed-time refreshes, repaint, or resize. A rule that compacts is consumed once; otherwise it stays pending. Pins, disabled settings, and manual hide prevent automatic compaction.

If maintenance ends and an extension starts a custom run without an observed idle gap, the rule can wait one extra cycle. Pi exposes no exact run-activity query to extensions.

An active job's manager detail screen can compact or remove only that job's widget row. Removal does not cancel the job or suppress completion messages.
Removal remains in effect across active-job snapshots until **Reset item views**, or until the job ID leaves the active snapshot. Reset restores the current active rows and their item details, not the overall view, pin, or trigger.
If all items are removed, the widget and separator disappear. The summary counts include removed and otherwise omitted rows; the manager still lists the jobs.
Widget presentation choices reset on `session_start` (including reload and session replacement), `session_tree` navigation, and shutdown. Tree navigation resets presentation without cancelling active jobs.
Jobs, saved preferences, tool definitions, model context, and completion delivery are not changed by widget controls.

## 🛠️ Tools

The main Pi session exposes five fixed tools:

| Tool | Parameters | Purpose |
| --- | --- | --- |
| `subagent_spawn` | `task`, optional `provider`, `model`, `tools`, `skills`, `extensions`, `thinkingLevel`, `timeout` | Start one subagent job and return its `jobId`. |
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

## ⚙️ Settings

Use `/subagents settings` or the manager's Settings action to edit user display preferences.
All four fields accept JSON booleans:

| Field | Default | Effect |
| --- | --- | --- |
| `showWidget` | `true` | Show the above-editor widget. |
| `showJobId` | `false` | Show job IDs in widget rows. |
| `showTools` | `false` | Show selected tool names in widget rows. |
| `showTiming` | `true` | Show running elapsed time and configured timeouts. |

Successful UI saves apply immediately. Hiding the widget does not stop jobs, change model tools, or suppress completion messages.
Showing it again displays currently active jobs with the other saved preferences. Job state and the task preview remain visible when the widget is enabled.
Escape returns or closes without undoing completed saves; Ctrl+C closes the entire flow.
Settings uses Pi's configured selection keys. Its footer shows only the hard-cancel key to avoid displaying fixed keys that do not match your bindings.

Preferences are saved in `<getAgentDir()>/pi-subagents.json`, normally `~/.pi/agent/pi-subagents.json`.
Only user settings are supported; project files and legacy settings are not read. User fields override code defaults, including saved values from before a default change.
Manual file edits are re-read on `session_start`, including `/reload`, and before each UI save.
Reading defaults creates no file. Invalid values produce diagnostics and use their defaults; malformed documents block saves until repaired.
Saves preserve unknown fields, publish atomically, and keep reads and writes ordered within one Pi process. Separate Pi processes are not locked.
A failed save keeps the previous effective preference and reports the error.

## ⚙️ Job configuration

The task should state the child's role, objective, scope, constraints, and expected result.
For reusable delegation policy, you can create your own project skill under `.pi/skills/<your-skill>/SKILL.md` or global skill under `~/.pi/agent/skills/<your-skill>/SKILL.md`.
Choose its name, trigger, tool policy, task format, and verification workflow for your use case.
The package intentionally registers and publishes no skill; the repository-only [`using-pi-subagents` example](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-subagents/skills/using-pi-subagents) is an optional starting point.

`subagent_spawn` accepts this additive configuration:

```ts
{
  task: string;
  provider?: string;
  model?: string;
  tools?: Array<"read" | "bash" | "powershell" | "edit" | "write" | "grep" | "find" | "ls" | "codemode">;
  skills?: string[];
  extensions?: Array<{ path: string; tools: string[] }>;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  timeout?: number;
}
```

`provider` and `model` are exact IDs. Each omitted field inherits independently from the main agent at spawn time; later parent changes do not affect the job.
A provider-only override retains the parent's model ID and fails if that pair is unavailable. To select another pair explicitly:

```ts
{ task: "Review the parser without changing files.", provider: "openai", model: "gpt-5.5" }
```

Only the child checks exact model registration and current availability. Every job requires a registered chat model and child-visible credentials, including jobs that inherit both fields.
A missing or unavailable model fails the job after `subagent_spawn` returns its `jobId`, before the task reaches any model. Use `subagent_wait` to read the failure.
Unlisted custom IDs previously accepted by Pi's CLI now fail; register the exact model in Pi's `models.json` or attach a trusted extension that registers it in the child.
See [Model selection](./docs/tools.md#model-selection) for exact matching, error timing, and virtual-model behavior.

The optional `tools` list selects Pi core work tools and the built-in `codemode` tool.
Omitting it selects `read`, `grep`, `find`, and `ls`, while an empty list gives the child no core work tools.
The runtime always adds `subagent_send` and child `subagent_wait` and removes duplicate names.
Adding `edit` or `write` lets the child modify files, while `bash` or `powershell` grants unrestricted command execution.

Add `"codemode"` explicitly to let the child run JavaScript that calls its selected tools and communication tools, including parallel calls and output filtering.
For example, `tools: ["read", "grep", "codemode"]` enables scripted read and search operations without shell or file-mutation tools.
The runtime loads Pi's built-in codemode extension and verifies tool readiness before sending the task; it does not enable automatic extension or MCP discovery.
Codemode follows Pi's effective `codemode` settings and also provides Pi's `models` API for classifier and image calls using child-visible credentials.
Those model calls can send data to providers and incur costs.

The optional `skills` list attaches local Pi skills through progressive disclosure without injecting their full bodies or adding tools.
Every attached skill path must contain at least one loadable skill, every non-ignored declared skill must load successfully, and skill names must be unique across attachments.

Each `extensions` entry loads a trusted local extension file or directory and selects its initial extension tools.
An empty `tools` list loads provider or lifecycle behavior without initially exposing extension tools.
The parent checks that each requested tool comes from its specified attachment before the child model receives the task.
Attached extensions run with the child's user permissions and are not a sandbox.

Attachments must be existing local paths, not npm, Git, or URL sources.
Project-local attachments and resources resolved from their packages require project trust, including paths that symlink into the project.
A job accepts up to 16 skill paths, 16 extension entries, and 64 selected work tools.
The child uses the main agent's thinking level unless `thinkingLevel` is supplied; Pi clamps it to the selected model's supported levels.
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
The current `/subagents` manager provides job metadata, cancellation, and widget preferences; it does not restore the legacy management workflows or settings.
Legacy retained follow-ups, `subagent_mailbox`, `subagent_consult`, custom agent catalogs, advanced orchestration, alternate transports, trust-aware cwd policy, and extension-owned worktrees have no direct replacement.
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
- The extension does not provide custom agents, custom system prompts, peer-to-peer child messaging, retained conversations, user-directed follow-up work, mailboxes, Agent Teams, chains, fan-in aggregators, panels, workflow DAGs, dynamic scheduling, verification orchestration, nested subagents, or extension-owned semantic memory.
- Bidirectional messages use request-response coordination, not a retained conversational session.
- The main agent must verify child claims against the actual diff and deterministic checks.
- Child requests and responses trigger a main-agent turn, but asynchronous job completions do not wake an otherwise idle model turn automatically.
- Jobs, broker requests, and retained results do not survive extension reload, session replacement, or process exit.

## 🗂️ Package layout

```text
packages/pi-subagents/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   ├── subagents.ts                   # Commands and session lifecycle
│   ├── menu.ts                        # Job manager and session-local display controls
│   ├── widget.ts                      # Retained widget ownership and event policies
│   ├── widget-renderer.ts             # Bounded rows and active-job summaries
│   ├── settings.ts                    # User preferences and atomic storage
│   └── settings-ui.ts                 # Native settings editor
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
