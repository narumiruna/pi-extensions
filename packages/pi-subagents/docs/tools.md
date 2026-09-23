# Pi Subagents tools

## `subagent_spawn`

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `task` | `string` | Yes | Self-contained task, up to 50 KiB of UTF-8 text. |
| `tools` | `string[]` | No | Pi core tools: `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`; defaults to `read`, `grep`, `find`, `ls`. |
| `skills` | `string[]` | No | Up to 16 local skill files or directories; Pi uses progressive disclosure. |
| `extensions` | `{ path: string; tools: string[] }[]` | No | Up to 16 trusted local extensions and their initially selected tools. |
| `thinkingLevel` | `string` | No | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; defaults to the main agent's level. |
| `timeout` | `number` | No | Seconds; `> 0` through `2,147,483.647`; no default. |

Starts one job and returns its `jobId` immediately. The child inherits the main agent's effective model and always receives `subagent_send` and `subagent_wait`.

Skills do not add tools or inject their entire bodies. An extension's `tools` list selects its initial tools; use an empty list for provider or lifecycle behavior only. An attached extension runs trusted code with full child-process permissions, not in a sandbox.

Attachments must be existing local paths. Every non-ignored declared skill must load successfully, each skill name must be unique, and each skill path must contain at least one loadable Pi skill. Missing or misattributed extension tools fail before the child model receives the task. See [Attachment behavior](./attachments.md) for validation, trust, limits, provider credentials, and startup failures.

## `subagent_inspect`

No parameters. Returns privacy-filtered retained-job metadata without task text, output, selected tools, attachment paths, credentials, or messages.

## `subagent_cancel`

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `jobId` | `string` | Yes | Job ID returned by `subagent_spawn`. |

Cancels a queued or running job; repeating the call is safe.

## `subagent_wait`

### Main agent

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `jobId` | `string` | Yes | Job ID to wait for. |
| `timeout` | `number` | No | Seconds; `> 0` through `2,147,483.647`; no default. |

Returns the job result, or returns early with `reason: "subagent_message"` when a child request or response arrives. A wait timeout does not cancel the job.

### Subagent

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `requestId` | `string` | Yes | Request ID returned by a child-originated `subagent_send`. |
| `timeout` | `number` | No | Seconds; `> 0` through `2,147,483.647`; no default. |

Returns the main agent's response as plain text. A timeout, cancellation, or incoming main-agent request throws and stops only this wait; the original request remains active and can be waited on again.

## `subagent_send`

Main and child processes receive separate tool definitions.

### Main agent

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `recipient` | `string` | Conditional | Active job ID for a new request. |
| `requestId` | `string` | Conditional | Pending child request to answer. |
| `message` | `string` | Yes | Plain text, up to 48 KiB of UTF-8 text and 1,992 lines. |

Provide exactly one of `recipient` (new request) or `requestId` (response).

### Subagent

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `requestId` | `string` | No | Pending main-agent request to answer; omit to start a request. |
| `message` | `string` | Yes | Plain text, up to 48 KiB of UTF-8 text and 1,992 lines. |

A new request returns a `requestId` for an optional `subagent_wait` call. A successful send or response returns `{ requestId, accepted, duplicate }`.

See [Messaging and lifecycle](./messaging.md) for delivery, cancellation, retry, and response behavior.
