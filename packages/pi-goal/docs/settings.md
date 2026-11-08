# Pi Goal settings reference

[Back to README](../README.md)

This reference covers safety limits, managed-run access, settings persistence, and compatibility.
For installation and first use, start with the README.

## Settings and safety limits

Settings are optional.
When `~/.pi/agent/pi-goal.json` is absent, pi-goal uses these built-in defaults without creating the file:

```json
{
  "rpc": {
    "enabled": false
  },
  "retryUsageLimits": false,
  "continuationLimits": {
    "automaticTurns": 25,
    "noProgressTurns": 3
  }
}
```

Use `/goal` → **Settings…** in the TUI to create or update the file, or edit it directly.
The Settings screen shows all four controls on one level.
The two safety limits open separate choice screens:

- **Automatic-work limit** shows the exact response limit or **Unlimited**.
  Choose **Set response limit…** to edit the current finite value (or the built-in default of 25 when switching from Unlimited), or choose **Unlimited…**.
  Unlimited requires confirmation that tool loops may continue consuming tokens and provider cost without a response-count cap.
- **No-progress guard** shows **_N_ runs** or **Off**.
  Choose the default threshold, **Off**, or **Set threshold…** and enter a safe whole number greater than zero.
- **Retry usage limits** is an **On**/**Off** row, defaulting to **Off**.
  It enables scheduled recovery after recognized provider quota errors; read the [recovery policy](#usage-limit-recovery) before enabling it.
- **Managed run RPC** controls whether trusted installed extensions may start and cancel managed Goal runs.
  It defaults to **Off** and controls cooperation, not extension permissions.

Custom number inputs accept only positive safe integers.
Choose **Unlimited** or **Off** explicitly instead of entering zero, a negative number, a decimal, or text.
Interactive changes run in order, publish atomically, preserve unknown fields, and apply to the current runtime.
A successful save updates the visible state immediately.
A failed save restores the prior value and reports the settings path so it can be retried.
Escape returns to the previous screen without reverting changes that were already saved.

Pi-goal registers `goal_complete`, `goal_blocked`, and `goal_wait` once and keeps their schemas stable from startup.
Visible Goal tools do not mean Goal mode is active, and only the latest effective active Goal contract authorizes their use.
Pi-goal never widens a restrictive active-tool policy; activation rejects when required terminal tools are missing, and an active Goal pauses if they later disappear.
The retired `toolVisibility` key is ignored and preserved as unknown data when another setting is saved.

`experimental.goals` is a removed legacy setting.
If it remains `true`, pi-goal accepts the settings file and ignores the old queue feature.
Affected users see a warning that recommends `/goal edit` for an active objective or `/goal <objectives>` when no goal is active.
Later settings saves preserve unknown legacy fields instead of deleting them.

`rpc.enabled` accepts a boolean and defaults to `false`.
When disabled, a valid managed-run start receives `RPC_DISABLED`; manual and restored Goals remain unchanged.
A Settings-menu change applies immediately after its atomic save.
Disabling rejects new starts but lets an already accepted run continue publishing its exact state and accept its exact cancellation until terminal, avoiding stranded work.
Reload, replacement, and shutdown clear that in-memory ownership.

`continuationLimits` controls the automatic-work safety guards:

- `automaticTurns` accepts a positive safe integer or `null` and defaults to `25`.
  It counts completed normal `turn_end` responses owned by automatically started Goal work, including model responses inside tool loops and matching Pi-owned retries.
  The only quota-recovery exception is a work-free, directly quota-rejected scheduled request, as described below.
  The user-triggered kickoff, resume, edit, and ordinary user runs are not charged.
  At the limit, the goal becomes `paused` with cause `continuation_limit` and pending continuation or recovery is cancelled.
  The current operation is aborted before a 26th normal response starts.
  Pi may invoke a provider adapter once more with an already-aborted signal to produce its synthetic terminal event; that event is not counted and cannot resume Goal work.
  Set this field explicitly to `null` to opt into Unlimited mode; existing explicit `null` values remain compatible.
- `noProgressTurns` is a positive safe integer and defaults to `3`.
  At the end of an automatic run, pi-goal compares visible assistant text after Unicode normalization, lowercase conversion, control-character removal, and whitespace collapse.
  Thinking and tool blocks are excluded; empty and punctuation-only output are equivalent.
  Consecutive empty or identical tool-free outputs increment the repeat count.
  Different non-empty output starts a new run at one, and any attempted tool call resets it.
  Set this field to `null` to disable only this heuristic.

## Usage-limit recovery

`retryUsageLimits` accepts only a boolean and defaults to `false`.
With recovery disabled, a final recognized quota error stops the Goal as `usage_limited`; resolve the account condition and run `/goal resume` manually.
To opt in, use **Retry usage limits** in Settings or set `"retryUsageLimits": true` in the user settings file and reload.
There are no interval, retry-count, or provider-specific settings.

When enabled, recovery keeps the same Goal ID, cumulative usage, safety counters, managed run, and cooperative workflow ownership in active waiting.
Quiet waiting does not count toward active elapsed time.
A usable public reset hint determines the next recovery deadline; otherwise the fallback is 15 minutes.
Another extension or usage service is not required.
The public usage API cannot always establish which limits apply, including for Codex; a displayed reset time does not guarantee an actionable hint or available quota.
See the [lifecycle reference](./continuation-lifecycle.md#optional-usage-limit-recovery) for hint validation and dispatch rules.

Waiting and read-only usage queries do not count as model responses.
Only a scheduled recovery request that is directly rejected by a recognized usage limit without actual work is exempt from automatic-work and no-progress counters.
Successful responses, partial work, the original rejected request, manual requests, and existing native retry work retain their existing accounting.
All provider-reported token usage is retained, including failed-request usage.
Recovery does not reset counters or bypass an exhausted work, no-progress, or token limit.

The classifier is unchanged and includes subscription, billing, and credit exhaustion, not just temporary quotas.
Recovery can wait indefinitely for account-owner action and can make paid requests when a deadline or external input wakes the Goal.
It does not redeem credits, change authentication, or modify provider settings.
Pi's native retry policy, ordinary `goal_wait`, and external-input wake behavior are unchanged.

Turning recovery **Off** after a committed settings save cancels pending quota recovery and stops that Goal as `usage_limited` for manual recovery.
A failed save does not commit that stop.
Turning it **On** does not restart an already stopped Goal; resume it explicitly.
Pause, clear, edit, replacement, completion, terminal limits, session replacement, shutdown, and observed model changes cancel pending recovery work.
Reload restores the absolute deadline instead of restarting the interval.
Pi does not report every credential change immediately, so immediate account-switch detection is not guaranteed.

Live quota reset, provider accounting delay, entitlement behavior, and agreement with a provider console remain unverified.
No live provider traffic was authorized for this change; deterministic verification does not establish those external behaviors.

## Loading and compatibility

The settings file is user-scoped at `<getAgentDir()>/pi-goal.json`, normally `~/.pi/agent/pi-goal.json`; Goal has no project settings override.
Omitted fields use built-in defaults, and explicit valid user values override them.
Settings reads do not create files or directories.
Saves are ordered within one Pi process; they do not coordinate separate Pi processes.

Settings are reread at Pi startup, session replacement, and `/reload`.
Direct file edits are not watched, while Goal-menu changes apply immediately.
A missing file remains absent and uses the built-in defaults.
The first successful settings change creates the file atomically; later saves preserve unknown fields.
Omitted fields use the defaults above.

Invalid or malformed existing settings are never overwritten; they produce a warning and fall back to all defaults.
In the TUI, Goal Settings becomes a read-only summary that identifies the invalid file and tells you to fix it and run `/reload`.

Plan mode or another restrictive policy may hide Goal tools.
Pi-goal does not override that policy during restore or later turns.
Activation fails when required terminal tools are unavailable, and an active goal pauses without automatic continuation if they disappear.
A restrictive allowlist created before `goal_wait` existed can still run ordinary Goals with `goal_complete` and `goal_blocked`.
The model cannot enter external waiting until that allowlist also includes `goal_wait`.
The pause aborts a Goal-owned kickoff, resume, active edit, or automatic-continuation prompt.
It does not cancel or stale-block unrelated user or extension turns, including startup follow-ups after a restrictive restore.
