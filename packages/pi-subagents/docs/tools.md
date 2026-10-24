# Pi Subagents tools

The process backend is the default. The experimental durable backend uses different tool definitions, selected with `durable: true` in extension settings. Run `/reload` after changing the backend. See [Durable Subagents](./durable.md) for prerequisites, settings, persistence, and recovery limits.

Process tools use job IDs; durable tools use conversation IDs scoped to the current main session's private store. These IDs are not interchangeable. Durable conversation IDs are decimal strings without a leading zero, up to 32 characters.

## `subagent_spawn`

### Process backend

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `task` | `string` | Yes | Self-contained task, up to 50 KiB of UTF-8 text. |
| `tools` | `string[]` | No | Pi tools: `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`, `codemode`; defaults to `read`, `grep`, `find`, `ls`. |
| `skills` | `string[]` | No | Up to 16 local skill files or directories; Pi uses progressive disclosure. |
| `extensions` | `{ path: string; tools: string[] }[]` | No | Up to 16 trusted local extensions and their initially selected tools. |
| `thinkingLevel` | `string` | No | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; defaults to the main agent's level. |
| `timeout` | `number` | No | Seconds; `> 0` through `2,147,483.647`; no default. |

Starts one job and returns its `jobId` immediately. The child inherits the main agent's effective model and always receives `subagent_send` and `subagent_wait`.

Select `codemode` explicitly with the other required tools, for example `tools: ["read", "grep", "codemode"]`.
Pi's built-in codemode extension runs scripts against the child's callable tools, including `subagent_send` and `subagent_wait`; automatic resource discovery stays disabled.
Codemode also exposes Pi's classifier and image model API using child-visible credentials; these calls can send data to providers and incur costs.
The default tools do not include codemode.

Skills do not add tools or inject their entire bodies. An extension's `tools` list selects its initial tools; use an empty list for provider or lifecycle behavior only. An attached extension runs trusted code with full child-process permissions, not in a sandbox.

Attachments must be existing local paths. Every non-ignored declared skill must load successfully, each skill name must be unique, and each skill path must contain at least one loadable Pi skill. Missing or misattributed extension tools fail before the child model receives the task. See [Attachment behavior](./attachments.md) for validation, trust, limits, provider credentials, and startup failures.

### Durable backend

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `task` | `string` | Yes | Nonempty text without NUL, up to 50 KiB of UTF-8 text. |
| `tools` | `string[]` | No | Up to 64 names: `read`, `write`, `edit`, `bash`, `powershell`; defaults to `read`. An empty list selects no work tools. |
| `skills` | `string[]` | No | Unsupported; omit or pass an empty array. |
| `extensions` | `{ path: string; tools: string[] }[]` | No | Unsupported; omit or pass an empty array. |
| `thinkingLevel` | `string` | No | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; defaults to the main agent's level, subject to model support. |
| `timeout` | `number` | No | Initial assignment timeout in seconds; `> 0` through `2,147,483.647`; no default. |

Starts a persistent conversation and returns its `conversationId` and request receipt immediately. It uses the main session's selected model and runs inside the host Pi process, not a separate Pi child. Later assignments retain its model, thinking level, tools, working directory, and trust profile.

Nonempty attachments and the tools `grep`, `find`, `ls`, and `codemode` are rejected. Durable children do not receive the process backend's communication tools. Native work tools run with the Pi process's user permissions, not in a sandbox.

## `subagent_inspect`

Process backend only. No parameters. Returns privacy-filtered retained-job metadata without task text, output, selected tools, attachment paths, credentials, or messages.

## `subagent_cancel`

Process backend only.

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `jobId` | `string` | Yes | Job ID returned by `subagent_spawn`. |

Cancels a queued or running job; repeating the call is safe. The job cannot accept later assignments.

## `subagent_stop`

Durable backend only.

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `conversationId` | `string` | Yes | Conversation ID returned by durable `subagent_spawn`. |

Stops current and queued work captured by the invocation without closing the conversation. New assignments are rejected while stop processing is in progress and accepted afterward. Replaying the same invocation cannot stop newer work. Stop does not undo external effects or retract delivered reports.

## `subagent_status`

Durable backend only.

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `conversationId` | `string` | No | Conversation ID to inspect; omit to list owned conversations. |

Returns privacy-filtered metadata with `running` / `idle` state, latest request outcome metadata, and a top-level `deliveryPending` diagnostic. It omits task text, conversation content, selected tools, and credentials. Completed work can still show `running` while a result awaits acknowledgement by the main session. `deliveryPending: false` does not prove every report was delivered.

## `subagent_wait`

### Process backend: main agent

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `jobId` | `string` | Yes | Job ID to wait for. |
| `timeout` | `number` | No | Seconds; `> 0` through `2,147,483.647`; no default. |

Returns the job result, or returns early with `reason: "subagent_message"` when a child request or response arrives. A timeout or caller cancellation stops only the wait, not the job.

### Process backend: subagent

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `requestId` | `string` | Yes | Request ID returned by a child-originated `subagent_send`. |
| `timeout` | `number` | No | Seconds; `> 0` through `2,147,483.647`; no default. |

Returns the main agent's response as plain text. A timeout, cancellation, or incoming main-agent request throws and stops only this wait; the original request remains active and can be waited on again.

### Durable backend: main agent

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `conversationId` | `string` | Yes | Conversation ID returned by durable `subagent_spawn`. |
| `timeout` | `number` | No | Wait timeout in seconds; `> 0` through `2,147,483.647`; no default. |

Waits for assignments submitted when this wait starts and returns the latest captured assignment's saved outcome and result, not every answer. Later sends do not extend the wait. A timeout returns `timedOut: true`; caller cancellation fails only the waiter. Neither cancels the assignments.

## `subagent_send`

### Process backend: main agent

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `recipient` | `string` | Conditional | Active job ID for a new request. |
| `requestId` | `string` | Conditional | Pending child request to answer. |
| `message` | `string` | Yes | Plain text, up to 48 KiB of UTF-8 text and 1,992 lines. |

Provide exactly one of `recipient` (new request) or `requestId` (response).

### Process backend: subagent

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `requestId` | `string` | No | Pending main-agent request to answer; omit to start a request. |
| `message` | `string` | Yes | Plain text, up to 48 KiB of UTF-8 text and 1,992 lines. |

Main and child processes receive separate tool definitions. A new request returns a `requestId` for an optional `subagent_wait` call. A successful send or response returns `{ requestId, accepted, duplicate }`.

See [Messaging and lifecycle](./messaging.md) for delivery, cancellation, retry, and response behavior.

### Durable backend: main agent

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `conversationId` | `string` | Yes | Conversation ID returned by durable `subagent_spawn`. |
| `message` | `string` | Yes | Nonempty text without NUL, up to 48 KiB of UTF-8 text and 1,992 lines. |
| `whenBusy` | `string` | No | `"steer"` or `"followUp"`; defaults to `"steer"`. |

Assigns work to a running or idle conversation and returns a request receipt. When busy, `"steer"` directs the message into current work; `"followUp"` queues it after the current answer. This is not the process backend's `requestId` question-response protocol.
