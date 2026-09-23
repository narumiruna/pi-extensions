# Pi Subagents tools

## `subagent_spawn`

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `task` | `string` | Yes | Self-contained task, up to 50 KiB of UTF-8 text. |
| `tools` | `string[]` | No | Up to 64 total selected names after extension tools are included; core names are `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`; defaults to `read`, `grep`, `find`, and `ls`. |
| `skills` | `string[]` | No | Up to 16 explicit local Markdown skill files or directories containing a loadable Pi skill; skill names must be unique and automatic discovery remains disabled. |
| `extensions` | `{ path: string; tools: string[] }[]` | No | Up to 16 trusted local extension files or directories and the exact extension tools to activate initially. |
| `thinkingLevel` | `string` | No | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; defaults to the main agent's effective thinking level. |
| `timeout` | `number` | No | Seconds; `> 0` through `2,147,483.647`; no default timeout. |

Starts one task-specialized subagent job with the selected capabilities and returns its job ID immediately.

The runtime always adds `subagent_send` and `subagent_wait` to the selected tools.

`tools` accepts only the fixed Pi core names in the table.

Extension tools are selected only through each `extensions[].tools` list, and an empty list loads provider or lifecycle behavior without exposing extension tools initially.

Every requested extension tool name must be non-empty, at most 128 characters, and contain no comma or control character.
The complete child bootstrap, including selected and communication tool names, must fit 16 KiB of UTF-8 JSON or spawn throws before launch.

Whenever an extension is attached, the parent verifies that the complete initial allowlist is active after extension factory, session, and resource-discovery hooks and uses an ordered RPC barrier to observe startup hook errors before submitting the task to the model.

A missing tool, malformed readiness response, attachment startup failure, or cancellation fails the job without sending the task.

`skills` uses Pi's progressive disclosure, so an attached skill becomes available for relevant discovery but does not inject its full body, add tools, or force invocation.

Pi's skill loader must find at least one loadable skill in every attached skill path, every declared skill discovered within a directory must load successfully, and every loaded skill name must be unique across the combined attachments.
Combined skill preflight is asynchronous and cancellation-aware, and it rejects recursive directory links or requests exceeding 4,096 entries, depth 32, 4 MiB of candidate skill content, or 1 MiB of ignore-file content before Pi's synchronous loader runs.
Non-Markdown files, unloadable or unreadable declared skills, ignored skills, directories without a loadable skill, and duplicate skill names throw before launch.

Extension-package preflight is asynchronous and cancellation-aware, rejects source globs in every Pi resource declaration, recursive resource directory links, and non-regular manifests or ignore files, requires every exact extension declaration to contribute a directly loadable entrypoint, and limits Pi package discovery to 4,096 entries, depth 32, and 1 MiB of metadata.

Each attachment path is resolved relative to the child working directory when not absolute, must already name a regular file or directory, and is canonicalized before launch.

Only local paths are accepted; npm, Git, URL, and other scheme-based sources throw before queuing.

Paths are limited to 4 KiB of UTF-8 text, duplicate skills are removed, and repeated extension paths merge their tool names in first-use order.

When the project is untrusted, an attachment throws if either its lexical path or symlink-resolved target is within the child working directory; explicit external paths remain valid.

An attached extension executes trusted code with full child-process permissions and may alter prompts, tools, providers, or active tools after the initial readiness check, so its tool list is not a sandbox.

Canonical attachment paths are passed to Pi as child-process arguments but are omitted from inspection, completion, and broker results.

The child inherits the main agent's effective provider and model at spawn time.

A provider registered only by a parent extension throws before queuing unless at least one extension is attached.

With an attachment, child startup is authoritative because that extension may register the provider before model resolution.

A process-local runtime API key, including a parent-only `--api-key`, always throws before queuing; attached providers must use stored or inherited environment credentials independently.

Unavailable core tool names and invalid attachments throw without launching a child.

The session broker must also be available before a child can launch.

## `subagent_inspect`

No parameters.

Returns privacy-filtered retained-job metadata without task text, child output, selected tools, attachment paths or totals, credentials, or broker messages.

## `subagent_cancel`

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `jobId` | `string` | Yes | Job ID returned by `subagent_spawn`. |

## `subagent_wait`

### Main agent

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `jobId` | `string` | Yes | Job ID to wait for. |
| `timeout` | `number` | No | Seconds; `> 0` through `2,147,483.647`; no default and does not cancel the job. |

Returns `{ jobId, state, timedOut: false, interrupted: true, reason: "subagent_message" }` without cancelling the job when a child request or response arrives.

### Subagent

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `requestId` | `string` | Yes | Request ID returned by a child-originated `subagent_send`. |
| `timeout` | `number` | No | Seconds; `> 0` through `2,147,483.647`; no default and does not cancel the request. |

Returns the main agent's response as plain text.

A timeout, caller cancellation, or incoming main-agent request throws and stops only that wait, so the child may wait for the same request again.

The runtime interrupts an active child wait only after Pi RPC accepts the incoming main request for steering.

## `subagent_send`

Main and child processes receive separate provider-visible definitions for their own context.

### Main agent

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `recipient` | `string` | Conditional | Active job ID for a new request. |
| `requestId` | `string` | Conditional | Pending child request to answer. |
| `message` | `string` | Yes | Plain-text request or response, up to 48 KiB of UTF-8 text and 1,992 lines. |

Provide exactly one of `recipient` or `requestId`.

A new request provides an active queued or running job ID as `recipient` and omits `requestId`.

A response provides `requestId` and omits `recipient`.

### Subagent

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `requestId` | `string` | No | Pending main-agent request to answer; omit to start a new request to main. |
| `message` | `string` | Yes | Plain-text request or response, up to 48 KiB of UTF-8 text and 1,992 lines. |

A new request omits `requestId` and returns a request ID immediately for an optional `subagent_wait` call.

A response provides the pending main-agent `requestId`.

A main-originated request waits for the child RPC prompt to be accepted and then uses Pi steering to reach the running child.

After steering is queued, the runtime interrupts active child response waits without consuming their original requests.

Caller cancellation before RPC delivery starts rolls the request back.

Once RPC delivery starts, cancellation stops only the caller's wait; the request may still arrive and remains answerable until delivery fails or the job terminates.

A child response arrives asynchronously in the main session and interrupts the next active main-agent `subagent_wait`, including when the response arrived immediately before the wait started.

The first accepted response wins, and repeated responses acknowledge the existing response without replacing it.

Each job may have up to four unresolved or answered-but-not-consumed requests across both directions.

Requests and responses are limited to 1,992 lines so their protocol envelopes fit Pi's 2,000-line model-text bound.

Terminal jobs, unknown requests, cross-job responses, responses from the request originator, and stale session credentials throw.

A successful call returns `{ requestId, accepted, duplicate }`.
