# Pi Subagents v3 tools

## `subagent-v3-start`

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `agent` | `string` | Yes | Configured subagent name. |
| `task` | `string` | Yes | Self-contained task, up to 50 KiB of UTF-8 text. |
| `timeout` | `number` | No | Seconds; `> 0` through `2,147,483.647`; no default timeout. |

## `subagent-v3-inspect`

No parameters.

## `subagent-v3-cancel`

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `jobId` | `string` | Yes | Job ID returned by `subagent-v3-start`. |

## `subagent-v3-wait`

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `jobId` | `string` | Yes | Job ID to wait for. |
| `timeout` | `number` | No | Seconds; `> 0` through `2,147,483.647`; no default and does not cancel the job. |

## `subagent-v3-consult`

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `agent` | `string` | Yes | Configured subagent name. |
| `task` | `string` | Yes | Self-contained research or review question, up to 50 KiB of UTF-8 text. |
| `timeout` | `number` | No | Seconds; `> 0` through `2,147,483.647`; no default timeout. |
