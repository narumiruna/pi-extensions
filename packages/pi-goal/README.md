# 🎯 pi-goal — Keep Pi Working Toward a Goal

[![npm](https://img.shields.io/npm/v/@narumitw/pi-goal)](https://www.npmjs.com/package/@narumitw/pi-goal) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Give Pi one session-scoped objective and let it continue after Pi becomes fully idle.
Goal mode stops when work completes, pauses, waits for an external event, or reaches a safety limit.
Explicit completion, blocker, and wait tools give each managed run a clear stopping reason.

## ✨ Features

- Starts and manages one session goal through `/goal` and its status, pause, resume, edit, and clear routes.
- Continues exactly once from Pi's settled idle boundary after queued work, retries, and compaction have finished.
- Waits quietly for a follow-up when transient provider retries are exhausted instead of terminally blocking the Goal.
- Uses explicit `goal_complete`, `goal_blocked`, and `goal_wait` tools with stale-goal guards and evidence requirements.
- Renders an accepted `goal_complete` summary as Markdown in the TUI.
- Tracks active, paused, blocked, usage-limited, budget-limited, waiting, and complete outcomes separately.
- Pauses after a configurable response limit or repeated no-progress runs and offers a guided review before continuing.
- Supports optional token budgets that stop Goal-owned work immediately when exhausted.
- Keeps Goal continuation accounting out of the leading system instructions so post-activation provider request prefixes remain stable.
- Persists the goal in the current session across reload, resume, compatible forks, and compaction.
- Rejects stale continuations and tool calls after replacement, pause, completion, limits, or other terminal state changes.
- Optionally exposes a default-off protocol for trusted extensions to start, observe, and cancel one Goal lifecycle.

## 📦 Install

Requires Pi `0.80.6` or newer for the `agent_settled` lifecycle event.

```bash
pi install npm:@narumitw/pi-goal
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-goal
```

Build and try this package locally from the repository root:

```bash
npm --workspace @narumitw/pi-goal run build
pi -e ./packages/pi-goal
```

The package declares `dist/index.ts`, so Pi cannot load an unbuilt local checkout.
Pi extensions run with your user permissions.
Goal mode can start repeated paid model turns and edit the current workspace, so review its limits and source before installing it.

## 🚀 Quick start

Run `/goal <objective>` to start Goal mode, or run `/goal` to open the state-aware manager.
Use the manager to review, pause, resume, edit, or clear the current goal.

## ⚙️ Settings

Use `/goal` → **Settings…** in TUI mode, or edit `<getAgentDir()>/pi-goal.json` (normally `~/.pi/agent/pi-goal.json`).
A missing file uses the defaults without creating it:

```json
{
  "continuationLimits": {
    "automaticTurns": 25,
    "noProgressTurns": 3
  },
  "rpc": { "enabled": false }
}
```

The automatic-work limit counts model responses in Goal-owned automatic work, including tool loops.
The no-progress guard pauses repeated tool-free output.
Choose **Unlimited** or **Off** explicitly to disable the corresponding guard; Unlimited requires confirmation and can continue consuming tokens and provider cost.
Neither these guards nor an optional token budget is a dollar-cost cap.

Menu saves apply immediately, run in order, preserve unknown fields, and publish atomically.
Manual edits apply at session start or `/reload`.
Invalid settings remain untouched, use defaults, and make the TUI Settings screen read-only until repaired and reloaded.

Read the [settings reference](./docs/settings.md) for exact counting rules, accepted values, managed-run RPC behavior, tool-policy restrictions, and legacy-setting recovery.

## 🔒 Security and privacy

Goal mode can start repeated paid model turns and use active Pi tools, including tools that modify the workspace.
The default automatic-work limit and optional token budget reduce runaway work but are not dollar-cost caps.
Setting `rpc.enabled` to `true` lets trusted installed extensions request and cancel managed runs through Pi's shared event bus.
The protocol does not authenticate or sandbox installed extensions.
Workflow mutual exclusion is cooperative and does not prevent unrelated processes or extensions from editing the same workspace.

## 🤝 Workflow coexistence

Goal is independently installable and keeps its standalone behavior when no other protocol participant is present.
On the characterized Pi `0.84.2` runtime, it participates in the anonymous `workflow:mutex:v1` `agent-workflow` group.
An active Goal holds the group through ordinary work, external waiting, continuation delivery, compaction recovery, and provider retry.
Paused, blocked, usage-limited, budget-limited, complete, cleared, and legacy-queue-only states do not hold it.

Direct starts, menu starts, managed-run starts, stopped resumes, and stopped-goal edits use one final synchronous admission.
Admission occurs after validation and confirmation but before any tool, Goal-state, persistence, prompt, queue, or status mutation.
Replacing or editing an already active or waiting Goal retains its current owner.
If admission is busy, TUI and RPC show an anonymous warning, while print and JSON direct routes throw before mutation.
Managed-run RPC emits one terminal `ACTIVATION_FAILED` event without creating a Goal.

Restored active Goal state acquires before tool restoration, persistence publication, status, wait timers, retry state, or continuation work.
If restoration is busy, the Goal moves only to its existing paused safe state.
It does not change active tools or schedule work, and you can resume it after the other workflow ends.
Restored stopped Goals and inert legacy queues do not acquire or schedule automatic work.

An active Goal still pauses if a non-participating restrictive policy later removes its required terminal tools.

The coexistence guarantee is cooperative and applies only when every contender implements v1 on the characterized Pi runtime and shares its event bus and session-manager identity.
A pre-v1, mixed-version, non-participating, forked, or otherwise uncharacterized counterpart remains unsupported for mutual exclusion.
Goal does not identify, inspect, configure, start, stop, or depend on another extension.
Guaranteed coexistence with Plan mode requires `@narumitw/pi-plan-mode` `0.52.0` or newer and this package at `0.53.0` or newer on the characterized Pi `0.84.2` runtime.

| Installation | Support |
| --- | --- |
| Goal without another workflow participant | Supported standalone behavior |
| Goal `>=0.53.0` with Plan mode `>=0.52.0` on Pi `0.84.2` | Workflow Mutex v1 coexistence guarantee |
| Either package below its floor, or another Pi runtime | Standalone behavior only; mutual exclusion unsupported |

## 💬 Commands

```text
/goal
/goal status
/goal implement snake game
/goal --tokens 100k fix the failing test and verify it
/goal edit ship the smaller fix first
/goal pause
/goal resume
/goal clear
```

- In the TUI, `/goal` opens a standard state-aware manager.
  Its first action follows the current state: start when empty, pause when active, review a reached automatic-work limit, resume for other stopped states, or increase an exhausted token budget.
  Active and paused views show **Automatic work: _used_ of _limit_ responses** with the remaining count, or explicitly show **Unlimited**.
  A hard-cap pause opens **Review and continue…** and confirms that the objective, cumulative usage, and active time are preserved.
  Continuing resets the counter to zero and allows one more configured epoch.
  **Change automatic-work limit…** opens that setting while leaving the goal paused; Back and Escape make no change.
  **Start with token budget…** first offers `25k`, a suggested `100k`, `300k`, and **Set a custom budget…**, then collects the objective with the selected budget still visible.
  Custom input accepts examples such as `300000`, `300k`, `2.5k`, and `1.5m`; invalid input retains its draft for correction.
  Status, Settings, Help, invalid-settings guidance, Clear, and Close remain shallow, labeled routes.
  Arrow keys navigate, Enter selects or submits, Escape goes Back, and Ctrl+C closes the full flow.
- In RPC mode, bare `/goal` and `/goal status` report the current summary through an observable notification without opening terminal UI.
  Pi exposes no extension-command output channel in print or JSON mode.
  Those routes return an explicit unsupported-mode error instead of treating stderr as status output.
- Menu-driven Replace and Clear actions preview the exact affected goal and require confirmation.
  Existing direct routes remain immediate for compatibility and automation.
- `/goal <goal_to_complete>` starts goal mode.
  If another unfinished goal exists, Pi asks for confirmation before replacing it with a new active goal and resetting its usage counters.
  Failed kickoff delivery clears a new goal or restores the exact prior Goal and tool-policy snapshot; a previously active or waiting Goal keeps its existing workflow ownership.
- `/goal --tokens 100k <goal_to_complete>` starts or replaces goal mode with a token budget.
  `k` and `m` suffixes are accepted, for example `100k` or `1.5m`.
- `/goal edit <goal_to_complete>` updates the existing goal objective without resetting usage counters.
  A successful active edit rotates the stale-turn guard and starts a fresh safety epoch.
  Paused, blocked, and usage-limited goals stay stopped and retain their safety state until resume.
  A budget-limited goal reactivates only when `edit --tokens` raises its budget above current usage.
  Failed prompt delivery restores the exact previous Goal, guard id, safety counters, cause, tool-policy snapshot, and active ownership when applicable.
- `/goal pause` stops prompt injection and auto-continuation, aborts the current turn, and keeps the goal for later resume.
  Only active goals can be paused.
- `/goal resume` resumes a paused, blocked, usage-limited, or budget-limited goal when its token budget allows it.
  When the queued resume prompt starts, pi-goal rotates the stale-turn guard id, resets the automatic-response and repeat safety epoch, and clears a safety-pause cause.
  The command reports the new finite epoch or explicit Unlimited state.
  Objective, cumulative usage, and elapsed time are preserved.
  If prompt delivery fails, the original stopped state, guard id, counters, fingerprint, and cause are restored.
- `/goal clear` clears the current goal, status, pending continuation, inert legacy queue state, and legacy persisted state for the current working directory.
  It does not abort unrelated in-flight work.

The experimental ordered-goal queue has been removed.
Use `/goal edit <objective>` to reprioritize the active objective instead.
For example, if `task b` is complete and `task c` is in progress, edit the objective to say: `task b is complete; do task a next; after task a, continue task c, then task d; do not redo task b unless verification shows it is incomplete.`
Former queue command words such as `add`, `prioritize`, `drop-last`, `skip`, `push`, `unshift`, `pop`, and `shift` are ordinary objective text for unaffected users.
If a session still has legacy queue settings or persisted queue state, those words show a migration warning instead of replacing the active Goal.

Goal objectives are limited to 4,000 characters.
Put longer instructions in a file and reference the file path from `/goal`.

## 🛠️ Tools

- `goal_complete` records completion only for the exact active goal id, requires an evidence-based summary, and renders an accepted summary as Markdown in the TUI.
- `goal_blocked` records a true repeated impasse with the exact goal id, reason, evidence, and repeated-turn count.
- `goal_wait` pauses automatic continuation after the agent arranges an external wake source, with an optional bounded resume deadline.

## 🔁 Session and reload behavior

Goal state is stored in the current Pi session.
`/reload` and reopening the same Pi session can restore that session's unfinished goal.
An active restored goal at or above its finite automatic-work limit pauses before another provider request and reports that progress is saved.
Use `/goal` to review and continue.
A restored waiting Goal remains quiet, excludes offline and waiting wall time from active elapsed time, and restores only its absolute optional deadline timer.
An active restored goal pauses when workflow admission is busy or either required terminal tool is missing, without changing the active tool set.
Active elapsed time is checkpointed before shutdown and restarted after reload only when the Goal is not waiting, so offline and stopped wall-clock time is excluded.
Automatic-response counts, repeat fingerprints, and safety-pause causes persist across reload and compaction.
A direct non-`/goal` user or RPC input resets the safety epoch only while the goal is active and reclassifies the in-flight run as manual.
Extension input and messages sent while stopped do not reset it.
Starting a new Pi session in the same working directory does not inherit the old goal.

The legacy `{ goal }` shape remains valid, and missing safety fields normalize to zero/defaults.
Sessions created by the former standalone `pi-goals` experiment can still restore exactly one ordinary unfinished goal when no canonical `goal-state` entry exists.

If a session still contains old queue metadata, multiple legacy goals, a queued head, or a pending queue transition, pi-goal treats that state as inert legacy data.
It does not inject Goal prompts, advance the queue, or run any retained item automatically.
Affected users receive a warning that recommends starting one merged objective with `/goal <objectives>`, or using `/goal clear` to discard the old queue state.

Older versions wrote unfinished goals to `~/.pi/agent/pi-goal-state.json` keyed by working directory.
This version no longer reads that global file, and `/goal clear` removes any legacy entry for the current working directory.

## 📊 Statusline states

`pi-goal` writes compact plain status strings for statusline extensions.
`@narumitw/pi-statusline` adds the default `🎯` icon unless configured otherwise:

- `active 3m · automatic 12/25` — an active goal without a token budget; elapsed time counts only periods when its status is active and not waiting.
- `waiting review monitor · automatic 12/25` — an active Goal is quiet until non-Goal work or its optional deadline wakes it; the displayed reason is sanitized and bounded.
- `active 18k/100k · automatic 12/25` — an active goal with token usage and budget.
- `active 3m · automatic Unlimited` — explicit Unlimited automatic work.
- `paused · automatic limit 25/25` — the automatic-work limit paused the goal; `/goal` opens the recovery preview.
- `paused · automatic 12/25` — another pause reason stopped work while preserving the finite epoch.
- `blocked · automatic 12/25` — progress requires user or external action, or a terminal non-usage error stopped work.
- `usage · automatic 12/25` — the provider or account usage limit stopped work.
- `budget 100k/100k · automatic 12/25` — the user-configured token budget was reached; auto-continuation stops.
- `complete` — shown briefly after `goal_complete` succeeds.

## 💰 Token budgets and elapsed time

The TUI budget chooser treats a token budget as cumulative Goal usage and keeps the independent automatic-work response limit visible.
The final model call may exceed the selected token budget, so it is not a dollar-cost cap.
Choosing a preset or entering a custom value remains provisional until the objective is submitted; cancelling the chooser, custom input, or objective editor creates no Goal.
**Increase budget and resume…** shows the current budget and usage and requires a new total above current usage.
It previews the new total and automatic-work epoch, then resumes only after confirmation.
If the goal or its usage changes while that dialog is open, no change is applied.

For each persisted assistant message, `pi-goal` uses finite, non-negative `usage.totalTokens` when available.
For compatibility with older or partial records, it otherwise sums finite, non-negative `input + output + cacheRead + cacheWrite`.
It does not add `reasoning` because reasoning is already part of output, or `cacheWrite1h` because that is a subset of cache writes.
Goal usage is the current branch's cumulative assistant total minus the baseline captured when the goal started, clamped at zero after branch rewinds.

Provider usage becomes authoritative only when an assistant message finishes, so a budget can overshoot by one model call.
When completed tool activity first exposes exhaustion, the goal transitions once to `budget_limited`.
It cancels continuation, recovery, waits, and stale Goal-owned work, aborts the current turn, and releases workflow ownership.
It does not queue a summary or another model turn after budget exhaustion.
Stale Goal tool calls remain blocked until an unrelated user or extension turn begins or the Goal is explicitly reactivated.
A budget-limited Goal cannot call `goal_complete`; raise its budget above current usage and resume or edit it first.

The default 25-response automatic-work limit is a response-count boundary, not a fixed cost ceiling.
Context size, cache pricing, output length, and provider rates vary, and the final capped response is still retained.
Pi derives displayed cost estimates from provider-reported token usage and local model pricing; pi-goal does not query a billing balance or enforce a dollar cap.
For tighter token control, choose a smaller `automaticTurns` value and/or use `/goal --tokens`; choosing Unlimited removes only the response-count boundary.

Elapsed time is accumulated only while status is `active` and the Goal is not waiting.
Waiting, paused, blocked, usage-limited, budget-limited, shutdown, and offline periods do not increase it.
Legacy session entries are migrated by preserving their accumulated seconds and starting a fresh active clock when loaded.

## ✅ How completion works

While a goal is active, Goal-owned messages carry persistence rules and a `<goal_id>` stale-turn guard, and pi-goal exposes `goal_complete`.
Kickoff, resume, edited-objective, wait-resume, and automatic-continuation prompts place a trust boundary before the escaped objective and identify it as user-provided task data.
They preserve its full scope across turns and require the agent to derive concrete requirements from the objective and referenced artifacts.
The prompts treat the current worktree, command output, tests, runtime behavior, pull request state, rendered artifacts, and external state as authoritative.
Previous conversation and plans are context, not proof.

Goal helper names, definitions, and active prompt metadata remain stable across Goal activation, continuation, token accounting, wait resume, completion, and clearing.
Mode-only positive instructions live in the append-only active Goal contract instead of globally active tool prompt metadata.
Current token-budget usage is carried by the newly appended Goal prompt instead of rewriting leading system instructions.
The first accepted handoff for each Goal identity persists one deterministic hidden Goal contract at the same agent-start boundary, after previously retained conversation history.
The contract explicitly supersedes earlier Goal contracts, excludes mutable token, iteration, and elapsed-time counters, and stays at its appended history position.
Editing, replacing, and stopped-state resume append a new superseding active contract without deleting earlier provider input; failed handoff delivery appends no contract.
Completion, clearing, and stopped transitions append one inactive superseding contract.
Compaction and session restore append a missing current-state contract without waking a waiting Goal.
These structural guarantees make provider prefix reuse possible, but the provider still decides cache eligibility, cache hits, pricing, and billing.

Before completion, the shared audit tells the agent to treat completion as unproven.
The agent must inspect evidence for every named artifact, command, test, gate, invariant, and deliverable and match each check to the requirement it supports.
Weak, indirect, missing, or merely consistent evidence means work must continue.
This prompt wording is a behavioral guardrail, not proof.
Pi-goal can enforce the current goal id and reject empty or plainly contradictory summaries, but it cannot prove that external work is complete.

To finish, the agent must call `goal_complete` with the exact current `goal_id` and a `summary` of completion evidence.
Missing or stale `goal_id` values are rejected before summary validation.
Paused, blocked, usage-limited, and budget-limited goals cannot be completed until resumed.
The summary is completion evidence, not the stale-turn safety token.

If a turn ends before completion, `pi-goal` records usage and creates one continuation intent unless a circuit breaker pauses it first.
It dispatches that continuation only from Pi's `agent_settled` lifecycle.
Retries, automatic compaction, steering, and follow-up work must be drained, `ctx.isIdle()` must be true, and no messages may be pending.
Repeated settled events cannot dispatch the same intent twice.
Goal-owned kickoff, resume, active-edit, and automatic-continuation deliveries are bound to the goal instance that created them.
A delayed prompt from a replaced goal is aborted without rolling back, injecting, or stopping the newer goal.
Plain assistant text never marks a goal complete—even an exact-reply objective pauses safely when the model repeatedly omits `goal_complete`.

Manual compaction does not emit `agent_settled`, so its completion hook uses the same single-flight dispatcher only when Pi is idle.
Pi extensions cannot reserve an idle turn atomically like Codex core.
Another extension can win the race after the idle check, and its newer turn supersedes the old continuation intent.

## ⏳ External waiting

Use `goal_wait` only after arranging a monitor or other wake source that will inject a non-Goal message when external state changes:

```text
goal_wait({
  goal_id: "<current-goal-id>",
  reason: "Waiting for the review monitor",
  resume_after_ms: 300000
})
```

`goal_id` must match the current active Goal, `reason` must contain 1–1,000 characters, and the optional `resume_after_ms` must be a whole number from 1 through 2,147,483,647.
The deadline is a safety wake-up rather than a polling interval.
Requests below 10,000 milliseconds are accepted for compatibility but clamped to an effective 10,000-millisecond deadline.
The tool result reports both the requested and effective values.
Prefer deadlines measured in minutes instead of repeated short wakes.
Omitting `resume_after_ms` intentionally permits an indefinite quiet wait.

An accepted call keeps the canonical Goal status active, checkpoints active elapsed time, and cancels pending continuation work.
It persists the reason and optional absolute deadline and terminates the normal single-tool run.
Call `goal_wait` alone because Pi only guarantees early termination when every finalized result in a parallel tool batch terminates.

When Pi exhausts retries for a transient provider error such as HTTP 429, pi-goal enters the same active waiting state without a deadline instead of marking the Goal blocked.
The warning reports bounded provider status and explains that a follow-up or `/goal resume` retries the Goal.
Context-overflow compaction exhaustion remains blocked because another model turn can repeat the same oversized request without corrective compaction.

Interactive input, RPC input, another extension's `sendUserMessage()` input, and supported non-Goal custom follow-ups clear the wait before their turn runs.
pi-goal-owned kickoff, resume, edit, continuation, stale, or cancelled prompts do not count as external wake-ups.
Pi does not expose the sending extension's identity, so any non-Goal extension message is treated as a wake signal.

After a waking turn ends, ordinary continuation rules apply again.
The agent can complete or block the Goal, continue working, or call `goal_wait` again after arranging the next wake source.
`/goal resume` also clears waiting and sends one manual resume prompt without resetting cumulative usage or the safety epoch.
`/goal pause`, clear, edit, replace, completion, blocking, terminal limits, tool loss, session replacement, and shutdown cancel the in-memory deadline owner.

A future deadline is restored from its absolute timestamp after reload.
Reload never restarts, extends, or newly clamps an already-persisted absolute deadline, including a short deadline written by an older version.
An already-due deadline waits for Pi's settled, idle, no-pending-message boundary and then requests exactly one continuation through the normal dispatcher.
If that delivery throws, pi-goal restores the wait, retries once after one second, and leaves the Goal visibly waiting after a second failure instead of retry-looping.
A deadline never sends a prompt directly from a stale timer.

Waiting time is excluded from **Active elapsed**, while tokens, iteration, automatic-response count, no-progress state, and managed-run ownership remain preserved.
The managed-run protocol continues reporting `active` without a duplicate state event because waiting is non-terminal, including after transient provider retry exhaustion.
Editing or replacing a waiting Goal clears the previous wait so the updated objective performs a fresh external-state check.

## 🚧 Blocked goals

`goal_blocked` is intentionally narrower than completion or ordinary clarification.
Every goal-mode prompt requires these fields for the blocked audit:

- the exact current `goal_id`;
- a specific reason, up to 1,000 characters, describing the required user or external action;
- concrete evidence from failed resolution attempts, up to 4,000 characters;
- `repeated_turns` showing that the same blocker recurred for at least three consecutive goal turns.
A resumed goal starts a fresh blocker audit.
Empty or oversized reasons/evidence, stale ids, non-whole turn counts, stopped goals, and fewer than three turns are rejected.
Accepted blocker reports set `blocked`, stop automatic continuation, and terminate the tool batch when Pi can do so safely.

Do not use `goal_blocked` merely because work is difficult, incomplete, uncertain, awaiting normal clarification, or affected by a recoverable tool/provider failure.
The user can resolve the external condition and run `/goal resume` to rotate the goal id and continue.

## 🛑 Interruption and queued-input behavior

A user pause or aborted turn produces `paused`; a terminal provider/account quota error produces `usage_limited`; another non-retryable agent error produces `blocked`.
Each stopped transition cancels pending continuation intent or delivery and aborts stale work when applicable.
Stale tool calls remain blocked until the next non-goal user prompt, successful reactivation or replacement, or `/goal clear`.
On `/goal clear`, the extension clears goal state, continuation markers, and any stale tool-call block without aborting an unrelated in-flight turn.
Retryable provider interruptions and overflow compaction retries stay `active` while Pi retries.
No extra continuation is queued, and automatic ownership remains charged through retry `agent_start` events.
If matching provider recovery still exists at `agent_settled`, retries are exhausted and the Goal enters a deadline-free active wait before any continuation dispatches.
A later non-Goal input wakes the same Goal without rotating its stale-turn guard, so the model can continue, complete, or enter another wait with the current `goal_id`.
If matching compaction recovery still exists at `agent_settled`, the Goal becomes `blocked` because recovery did not produce usable context.
Stale recovery cannot wait or block a replacement goal.
User and extension work that starts before settlement supersedes the older continuation intent, and pending messages always take priority.

## 🤝 Managed run RPC

With `rpc.enabled: true`, pi-goal exposes a session-local, dependency-free protocol over Pi's shared `pi.events` bus.
It is intended for trusted sibling extensions that need to start, observe, and cancel one Goal lifecycle without driving the `/goal` command.
Installed Pi extensions remain fully privileged.
This setting controls only whether pi-goal cooperates with these channels; it does not provide authentication or sandboxing.

The public channels are:

```text
pi-goal:start
pi-goal:cancel
pi-goal:event:${runId}
```

The protocol intentionally has no separate version field or versioned channel namespace.
Before starting, the caller must generate a session-unique `runId`, subscribe to its event channel, and then emit:

```ts
pi.events.emit("pi-goal:start", {
  runId: "consumer-generated-run-id",
  objective: "Ship and verify the feature",
  tokenBudget: 100000, // optional positive integer
});
```

`runId` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; UUIDs are recommended.
It is a correlation identifier, not a secret or authenticated caller identity.
The objective uses the same 4,000-character validation as `/goal`, and `tokenBudget` is an absolute positive integer rather than a `k`/`m` string.

A successful start produces canonical state on `pi-goal:event:${runId}`:

```json
{
  "type": "state",
  "runId": "consumer-generated-run-id",
  "goalId": "<pi-goal-instance-id>",
  "status": "active"
}
```

Later state events use `active`, `complete`, `blocked`, `paused`, `usage_limited`, `budget_limited`, or `cleared`.
Only `complete` is a successful terminal outcome.
A matching completion may include `summary`; other terminal outcomes may include `reason`.
Events come only from canonical Goal persistence and only for the matching managed run.
Manual and restored Goals are not adopted or broadcast, unchanged persistence does not duplicate a status, and each run emits at most one terminal event.

Terminal events are dispatched after the underlying Goal transition settles.
A listener can start the next managed run directly after `complete` without re-entering completion cleanup.
Other terminal statuses leave a stopped Goal that must be resolved or cleared first.
If a manual edit, replacement, or edit transition rotates the Goal id, the prior managed run ends as `cleared` with a superseded reason; the replacement remains outside that run.

To cancel before or after activation, emit the same `runId`:

```ts
pi.events.emit("pi-goal:cancel", {
  runId: "consumer-generated-run-id",
  reason: "Parent work was cancelled", // optional, at most 1,000 characters
});
```

Cancellation uses the normal Goal pause transition.
It cannot affect a manual, restored, stale, or different run.
The resulting `paused` state is the cancellation result; there is no separate reply envelope.
A caller must not reopen a terminal `runId`, and a later manual `/goal resume` is outside that completed managed run.

Rejected operations emit a structured error on the same run event channel:

```json
{
  "type": "error",
  "runId": "consumer-generated-run-id",
  "operation": "start",
  "error": {
    "code": "RPC_DISABLED",
    "message": "Managed run RPC is disabled."
  }
}
```

Stable codes are `RPC_DISABLED`, `INVALID_REQUEST`, `NO_ACTIVE_SESSION`, `RUN_ID_IN_USE`, `RUN_NOT_FOUND`, `GOAL_ALREADY_EXISTS`, `ACTIVATION_FAILED`, and `SUPERSEDED`.
Consumers branch on `code`; `message` is diagnostic.
An unsafe or missing `runId` is ignored because there is no safe response channel.

Start never prompts for replacement: any pre-existing Goal is rejected.
The protocol binds only after current settings and restored Goal state load, and unbinds before session shutdown.
A caller must not assume that `emit()` waits for Goal completion; it should wait for a terminal run event and participate in its own session-shutdown cleanup.

This breaking contract replaces and removes `pi-goal:rpc:start`, `pi-goal:rpc:pause`, request-scoped start replies, and the global `pi-goal:state` broadcast.
No compatibility aliases are registered.

## 🧠 Use cases

- Finish implementation tasks without stopping at a plan.
- Keep debugging until the bug is verified fixed.
- Run refactors that require multiple tool cycles.
- Encourage agents to test, lint, or typecheck before completion.
- Make long-running Pi coding sessions more autonomous.

## 🗂️ Package layout

```text
packages/pi-goal/
├── src/                               # State, safety, waiting, settings, and protocol modules
│   ├── index.ts                       # Thin Pi entrypoint
│   └── goal.ts                        # Goal lifecycle, commands, and tools
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
├── docs/                              # Published reference documentation
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, goal mode, autonomous coding agent, AI agent workflow, task completion, agent loop, verification, TypeScript Pi package.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
