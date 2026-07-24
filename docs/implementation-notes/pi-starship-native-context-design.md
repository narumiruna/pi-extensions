# pi-starship Pi-native context design

Status: **design decision recorded; no new Pi-native module is approved for implementation**.

Reference runtime: `@earendil-works/pi-coding-agent` 0.80.10 installed typings and the extension
lifecycle documentation reviewed on 2026-07-24. Starship behavior references are pinned to
`9f4d07ed45804e280d6884bb8ced7ea3d3033093`.

## Decision

Keep `model`, `context`, `cost`, Git, and `activity` as the canonical owners. Do not add
provider-specific `claude_model`, `claude_context`, or `claude_cost` modules. Do not publish
`turn_duration`, `last_result`, or replacement names in this roadmap: Pi can support several precise
scopes, but the repository has no maintainer-approved user need or reset policy that selects one.
No implementation plan is created. A future proposal must obtain explicit approval for the exact
scope and names below before changing product code.

This no-change decision preserves the current compact footer, avoids duplicate information, and is
compatible with every existing format.

## Lifecycle feasibility matrix

| Signal | Installed event/field | Ordering and ownership | Feasibility / ambiguity |
| --- | --- | --- | --- |
| User request start | `before_agent_start.prompt` | After input expansion, before one agent loop | Suitable start for a user-prompt timer, but queued extension messages and retries complicate ownership |
| Low-level agent run | `agent_start` / `agent_end.messages` | May repeat for retry, compaction, or continuation | Precise run duration; not equivalent to a user turn |
| Fully settled work | `agent_settled` | After automatic retry, compaction retry, and queued continuation | Precise settled boundary, but the event carries no result payload |
| Model turn | `turn_start.{turnIndex,timestamp}` / `turn_end.{message,toolResults}` | Repeats for tool-use cycles in one agent run | Precise model-turn duration; not shell-command duration |
| Tool execution | `tool_execution_start` / `tool_execution_end.{result,isError}` | Parallel tools can overlap; each has a call id | Precise per-tool state; one failure may be recovered later |
| Cancellation/error | assistant `stopReason` in the latest `agent_end.messages` | `aborted`/`error` may precede a successful Pi retry | Cannot be called final until `agent_settled`; tool errors alone are not a user-turn result |
| Compaction | `session_before_compact` / `session_compact` with `reason` and `willRetry` | Overflow can be followed by a retry | Must remain inside a settled-work timer if that scope is chosen |
| Session replacement | `session_shutdown` then new `session_start` | Old contexts become stale | Any timer/result must be generation-owned and reset on replacement |
| Context use | `ctx.getContextUsage()` → tokens/window/percent or unknown | Current active model/session | Already owned by `context`; unknown immediately after compaction |
| Cost/tokens | assistant message usage on the active branch | Additive across persisted assistant messages | Already owned by `cost` and `tokens`; nested tool usage is included when Pi records it |
| Changed lines | cached Git diff shortstat | Workspace snapshot, not provider state | Already owned by `git_metrics`; paths are neither needed nor published |
| Model identity | `ctx.model.provider/id`, `model_select` | Current session model | Already owned by `provider` and `model` |

## Ownership and reuse matrix

| Candidate concept | Canonical owner | Possible future enhancement | Rejected alternative |
| --- | --- | --- | --- |
| Claude model label | `model` + `provider` | Exact user alias map on `model` | `claude_model`: duplicates state and fails for non-Claude providers |
| Context gauge/threshold | `context` | `$gauge` plus warning/critical thresholds | `claude_context`: provider-specific duplicate |
| Cost threshold | `cost` | Warning/critical threshold styles while retaining numeric `$cost` | `claude_cost`: provider-specific duplicate |
| Changed lines | `git_metrics` | None required; `$added`/`$deleted` already exist | A cost/activity changed-lines variable: duplicate ownership |
| Active/recent tool state | `activity` | A settled failure cue only if final semantics are approved | Shell-style `status`: conflates tool and agent outcome |
| Duration | No current owner | One precisely scoped future module | `turn_duration`: “turn” already means several different Pi boundaries |
| Result | No current owner | One settled-agent status if reliable final evidence is approved | `last_result`: does not say tool, model turn, agent run, or user request |

## Candidate future contract (unapproved)

This section fixes vocabulary for later review; it is not a compatibility promise.

### Existing-module enhancements

- `model.aliases`: exact model-id/name map applied before `$model`; no provider-only module.
- `context`: optional `$gauge`; integer `gauge_width` 1–40; `warning_threshold` and
  `critical_threshold` 0–100 with `warning < critical`; textual percentage remains visible so color is
  never the only warning.
- `cost`: optional nonnegative warning/critical thresholds with critical greater than warning;
  numeric cost remains visible.
- `activity`: no raw error, tool arguments, paths, or provider payloads. Any future failure cue must be
  based on settled final state, not an intermediate tool error.

### New concepts requiring a separate approval

`agent_duration` is preferred over `turn_duration` if the desired scope is from `before_agent_start`
through `agent_settled`, including tool loops, retries, and overflow compaction. Candidate variables:
`$duration` (human-readable) and `$milliseconds`; reset at the next accepted user/extension prompt or
session replacement; empty while no completed scope exists; cancellation still records elapsed time.
A low-level-run timer would instead be named `agent_run_duration`; a model-cycle timer would be
`model_turn_duration`. The generic `turn_duration` name is rejected.

`agent_result` is preferred over `last_result` only if “result” means the latest fully settled agent
scope. Candidate `$status` values are `success`, `failed`, `cancelled`, and `incomplete`; tool errors
that are recovered before settlement do not produce `failed`; `length` is `incomplete`; a successful
retry replaces an earlier error. Reset on the next accepted prompt and every session replacement.
Because `agent_settled` has no payload, implementation would retain the latest generation-owned
`agent_end` assistant stop reason and must prove retry/compaction ordering in tests. Raw errors are
never displayed. Generic `last_result` and shell exit-code emulation are rejected.

## Visibility and static examples

Classification:

- Primary: current model and near-limit context state.
- Supporting: numeric context, cost, and Git line metrics when selected.
- Contextual: active/recent activity and execution/deployment context.
- Advanced: aliases, gauges, thresholds, durations, and settled-result history.
- Safety/status: context warning/critical and a final failure cue; both require text/symbol changes in
  addition to color.

The existing default remains unchanged. These static examples show hierarchy, not approved syntax:

```text
wide idle/success:   anthropic sonnet-4  ctx 42%  $0.18
wide near limit:     anthropic sonnet-4  ctx ! 91% [#########-]  $0.18
wide final failure:  anthropic sonnet-4  failed  ctx 42%  $0.18
retry/compaction:    activity: retrying | compacting   (no final failure yet)
changed worktree:    git +28/-7          (owned only by git_metrics)
missing usage:       anthropic sonnet-4  (context module empty; no fabricated 0%)
narrow:              sonnet-4  !91%
```

At narrow widths, provider, gauge decoration, cost, and changed-line details may be omitted by the
user's format, but the percentage plus `!` must remain together if threshold behavior is enabled.
No example relies on color or provider-specific icons.

## Privacy, compatibility, and verification gate

- Never publish prompts, command arguments, tool payloads/results, raw errors, changed paths, API
  credentials, or provider request data.
- Model aliases are user-authored labels and may reveal naming choices; remain opt-in.
- Cost remains local branch usage data. Unknown usage is empty, never zero.
- Every state must be scoped by session generation; stale `agent_end`, timers, or shutdown callbacks
  cannot update a replacement session.
- Existing variables/defaults remain byte-compatible. New options must be catalog-owned, validated,
  documented, and opt-in.
- Any implementation plan must test success, tool-error recovery, provider retry, overflow compaction,
  cancellation, length stop, queued follow-up, missing usage, session replacement, narrow width, and
  non-color cues.

## Approval record

The roadmap records **no-change** for Pi-native modules. No public candidate name or lifecycle
semantic above is approved for implementation, and no implementation code was created. A future
maintainer approval must quote the accepted scope/name/reset contract and then create separate bounded
plans for existing-module enhancements and any genuinely new module.
