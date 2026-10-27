# Pi Subagents tools

## `subagent_spawn`

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `task` | `string` | Yes | Self-contained task, up to 50 KiB of UTF-8 text. |
| `provider` | `string` | No | Exact provider ID; defaults to the main agent's effective provider at spawn time. |
| `model` | `string` | No | Exact model ID within the selected provider; defaults independently to the main agent's effective model ID at spawn time. |
| `tools` | `string[]` | No | Pi tools: `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`, `codemode`; defaults to `read`, `grep`, `find`, `ls`. |
| `skills` | `string[]` | No | Up to 16 local skill files or directories; Pi uses progressive disclosure. |
| `extensions` | `{ path: string; tools: string[] }[]` | No | Up to 16 trusted local extensions and their initially selected tools. |
| `thinkingLevel` | `string` | No | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; defaults to the main agent's level. |
| `timeout` | `number` | No | Seconds; `> 0` through `2,147,483.647`; no default. |

Starts one job and returns its `jobId` without waiting for child startup. The child always receives `subagent_send` and `subagent_wait`.

Select `codemode` explicitly with the other required tools, for example `tools: ["read", "grep", "codemode"]`.
Pi's built-in codemode extension runs scripts against the child's callable tools, including `subagent_send` and `subagent_wait`; automatic resource discovery stays disabled.
Codemode also exposes Pi's classifier and image model API using child-visible credentials; these calls can send data to providers and incur costs.
The default tools do not include codemode.

Skills do not add tools or inject their entire bodies. An extension's `tools` list selects its initial tools; use an empty list for provider or lifecycle behavior only. An attached extension runs trusted code with full child-process permissions, not in a sandbox.

Attachments must be existing local paths. Every non-ignored declared skill must load successfully, each skill name must be unique, and each skill path must contain at least one loadable Pi skill. Missing or misattributed extension tools fail before the child model receives the task. See [Attachment behavior](./attachments.md) for validation, trust, limits, provider credentials, and startup failures.

### Model selection

Each omitted field inherits independently from one effective parent-model snapshot after attachment preflight, immediately before job admission. Supplying only `provider` keeps the parent's model ID; it never selects the new provider's default. Supplying only `model` keeps the parent's provider. Supplying both fields does not require a selected parent model. Later parent changes do not alter the admitted pair.

IDs are literal and case-sensitive. No trimming, aliases, fuzzy matches, combined provider/model syntax, thinking suffixes, or default fallback are applied. `/` and `:` remain part of a legitimate model ID. Listed IDs that differ only by case or contain provider-like prefixes select their exact entries, not Pi CLI pattern matches. Empty, whitespace-only, non-string, or control-containing values are rejected rather than inherited.

Only the child checks model registration and availability. Every job requires the exact pair to be a registered, available chat model in that child. The parent's model list does not limit the selection. Image and classifier models cannot run a subagent. Registered virtual chat models are supported when the child independently registers the same selection; parent-only routing state is not inherited. A trusted attached extension can register the pair before the child's readiness check.

The parent validates arguments, session state, attachments, and credential portability before job admission. These errors throw from `subagent_spawn`. Model registration and availability errors occur in the child after `subagent_spawn` returns a `jobId`; the job fails without sending its task to any model. Use `subagent_wait` to read the failure. Availability checks use Pi's current provider authentication and model filtering, not the remote service's entitlement checks; a later provider request can still fail. `thinkingLevel` remains a separate parameter and Pi clamps it to the selected model's capabilities.

**Compatibility:** unlisted custom model IDs that Pi's CLI previously accepted now fail, including inherited IDs. Add an exact chat-model entry to Pi's `models.json` or attach a trusted extension that registers it in the child. Reload the extension or start a new session after upgrading so the model receives the new fixed tool schema; per-job choices do not change that schema during ordinary turns.

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
