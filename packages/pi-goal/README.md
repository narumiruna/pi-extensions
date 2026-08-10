# 🎯 pi-goal — Goal Mode for the Pi Coding Agent

[![npm](https://img.shields.io/npm/v/@narumitw/pi-goal)](https://www.npmjs.com/package/@narumitw/pi-goal) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-goal` is a native [Pi coding agent](https://pi.dev) extension that adds session-scoped `/goal` commands, a `goal_complete({ goal_id, summary })` completion tool, a strict `goal_blocked({ goal_id, reason, evidence, repeated_turns })` impasse tool, and a `goal_wait({ goal_id, reason, resume_after_ms? })` tool for external-event waits. An opt-in experimental mode adds an ordered queue without introducing a second command or tool namespace.

Goal mode uses Codex-like persistence instructions and sends guarded continuation messages from Pi's fully settled idle boundary until the agent completes the goal, explicitly waits for an external event, the user pauses or clears it, a safety circuit breaker trips, a true blocker or provider usage limit stops it, or an optional token budget is reached. With ordered goals enabled, the same lifecycle advances through queued objectives one at a time.

## ✨ Features

- Adds `/goal <goal_to_complete>` to start goal mode, with confirmation before replacing an existing goal.
- Bare `/goal` opens a standard current-state manager in the TUI, with guided start, pause,
  resume, edit, queue, settings, status, help, and destructive-action confirmation; RPC mode retains
  observable status notifications.
- Keeps direct goal management available through `/goal` subcommands: `status`, `pause`, `resume`, `clear`, and `edit`.
- Exposes only one top-level command: `/goal`, including when ordered goals are enabled.
- Optionally adds ordered-goal operations through `/goal add`, `prioritize`, `drop-last`, and `skip`, while accepting `push`, `unshift`, `pop`, and `shift` as hidden compatibility aliases.
- Pauses automatic work after 25 Goal-owned model responses by default, preserves progress, and provides a guided review-and-continue flow; custom finite limits and confirmed Unlimited mode remain available.
- Pauses after three consecutive empty or normalized-identical tool-free automatic runs, while distinct short output and tool activity reset the repeat detector.
- Supports optional token budgets such as `/goal --tokens 100k <goal>`, using provider-reported total-token accounting with a cache-inclusive compatibility fallback.
- Tracks distinct `active`, `paused`, `blocked`, `usage_limited`, `budget_limited`, and `complete` states.
- Stores goal state in the current Pi session, following Codex's thread-owned goal model instead of using a global per-directory goal. Experimental queues keep independent budget, usage, elapsed-time, iteration, status, and stale-id accounting for every item.
- Registers a `goal_complete({ goal_id, summary })` tool for explicit completion, requiring the current goal id and rejecting missing/stale ids plus plainly contradictory summaries such as “not complete” or “tests still fail”.
- Registers `goal_blocked({ goal_id, reason, evidence, repeated_turns })` for true impasses only; it requires the current goal id, concrete evidence, and the same blocker recurring for at least three consecutive goal turns.
- Registers `goal_wait({ goal_id, reason, resume_after_ms? })` for an active Goal that has arranged an external wake message; waiting suppresses automatic continuation while preserving the objective, accounting, queue, and managed-run ownership.
- Keeps all three Goal tools active by default for a stable tool schema; optional `"after-first-goal"` visibility hides them until the first accepted `/goal` activation or an unfinished goal is restored, then keeps them desired for the rest of that extension runtime without overriding a restrictive restore policy.
- Records continuation and queue-transition intent, then triggers exactly one next turn only after Pi reports the agent fully settled, idle, and free of pending messages; an explicit wait remains quiet until non-Goal work or its optional deadline wakes it, and missing terminal tools still pause before another model turn.
- Lets retry, compaction, steering, follow-up, and other queued work settle before automatic goal continuation.
- Separates user interruption (`paused`), true impasse or terminal non-usage error (`blocked`), provider/account quota exhaustion (`usage_limited`), and user token budget exhaustion (`budget_limited`).
- Detects budget exhaustion after completed tool activity when assistant usage is persisted, then injects at most one non-user-authored wrap-up instruction and blocks further substantive tools.
- Keeps retryable provider interruptions and Pi compaction retries active without enqueueing duplicate goal continuations while Pi retries, then marks a matching unresolved error `blocked` only when `agent_settled` proves no retry, compaction, or follow-up remains.
- Preserves active goals across manual, threshold, and overflow compaction.
- Guards auto-follow-ups and Goal-owned kickoff deliveries so duplicate, replaced, stopped, cleared, completed, budget-limited, or stale queued prompts cannot continue or overwrite a newer goal.
- Rotates the completion guard id when a goal is resumed or edited so delayed old turns cannot complete the newer goal instance.
- Blocks stale tool calls after in-flight work pauses, blocks, or reaches a usage limit, until fresh non-goal user work, successful reactivation/replacement, or clear.
- Applies one evidence-based completion audit across kickoff, resume, edit, system, continuation, and budget-wrap-up prompts.
- Optionally exposes a default-off, run-scoped `pi.events` protocol for trusted sibling extensions to start, observe, and cancel one Goal lifecycle without emulating `/goal` input.

## 📦 Install

Requires Pi `0.80.6` or newer for the `agent_settled` lifecycle event.

```bash
pi install npm:@narumitw/pi-goal
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-goal
```

Try this package locally from the repository root:

```bash
pi -e ./packages/pi-goal
```

## ⚙️ Configuration

Settings are optional. When `~/.pi/agent/pi-goal.json` is absent, pi-goal uses these
built-in defaults without creating the file:

```json
{
  "toolVisibility": "always",
  "experimental": {
    "goals": false
  },
  "rpc": {
    "enabled": false
  },
  "continuationLimits": {
    "automaticTurns": 25,
    "noProgressTurns": 3,
    "minIntervalMs": 0
  }
}
```

Use `/goal` → **Settings…** in the TUI to create or update the file interactively, or create and edit it directly.
The standard Settings screen keeps all six controls on one level in task order.
The safety limits and continuation delay open standard choice screens:

- **Automatic-work limit** shows the exact response limit or **Unlimited**. Choose **Set response limit…** to edit the current finite value (or the built-in default of 25 when switching from Unlimited), or choose **Unlimited…**. Unlimited requires confirmation that tool loops may continue consuming tokens and provider cost without a response-count cap.
- **No-progress guard** shows **_N_ runs** or **Off**. Choose the default threshold, **Off**, or **Set threshold…** and enter a safe whole number greater than zero.
- **Continuation delay** shows **Off** for `0` or the configured milliseconds.
  Choose **Off** or **Set delay…** and enter a non-negative safe whole number of milliseconds.
- **Goal tools** controls whether all Goal tools are always visible or appear after the first goal.
- **Ordered goal queue** controls the experimental ordered-goal workflows.
- **Managed run RPC** controls whether trusted installed extensions may start and cancel managed Goal runs. It defaults to **Off** and is a cooperation setting, not an extension security sandbox.

Safety-limit number inputs reject zero, negative numbers, decimals, text, and unsafe integers without saving; use the explicit **Unlimited** or **Off** choice instead.
The continuation-delay input accepts zero and rejects negative numbers, decimals, text, and unsafe integers.
Interactive changes are serialized, written atomically, preserve unknown fields, and apply to the current runtime.
A successful change updates the visible state immediately.
A failed save restores the prior value and reports the settings path so it can be retried.
Tool-visibility changes that would alter the active tool schema are rejected while Pi is busy; retry after Pi settles.
Escape returns to the previous screen without reverting changes that were already saved.

`toolVisibility` accepts:

- `"always"` (default) — pi-goal does not proactively hide `goal_complete`, `goal_blocked`, or `goal_wait`, keeping the Goal tool schema stable from session startup.
- `"after-first-goal"` — hides all three Goal tools at fresh runtime startup, reveals them for the first accepted Goal activation, and treats an unfinished-goal restore as unlocked for the remainder of that extension runtime. On restore, pi-goal uses the active tools already established by earlier lifecycle handlers; it does not re-add missing terminal tools over a restrictive policy. Failed kickoff, replacement, resume, or reactivating-edit delivery restores the exact pre-activation tool set, including Goal tools exposed by another extension. If revealing the tools would widen an already-running turn, wait for Pi to become idle and retry `/goal`.

`experimental.goals` accepts a boolean and defaults to `false`. Set it to `true` to enable the ordered-goal subcommands and automatic queue advancement described below. Enabled sessions show one warning because command behavior and persisted queue state remain experimental.

`rpc.enabled` accepts a boolean and defaults to `false`. When disabled, a valid managed-run start receives `RPC_DISABLED`; manual and restored Goals remain unchanged. A Settings-menu change applies immediately after its atomic save. Disabling rejects new starts but lets an already accepted run continue publishing its exact state and accept its exact cancellation until terminal, avoiding stranded work. Reload, replacement, and shutdown clear that in-memory ownership.

`continuationLimits` controls the runaway guards:

- `automaticTurns` accepts a positive safe integer or `null` and defaults to `25`. It counts every completed normal `turn_end` owned by automatically started Goal work, including model responses inside tool loops and matching Pi-owned retries. The user-triggered kickoff, resume, edit, and ordinary user runs are not charged. At the limit, the goal becomes `paused` with cause `continuation_limit`, pending continuation/recovery is cancelled, and the current operation is aborted before a 26th normal response starts. Pi may invoke a provider adapter once more with an already-aborted signal to produce its synthetic terminal event; that event is not counted and cannot resume Goal work. Set this field explicitly to `null` to opt into Unlimited mode; existing explicit `null` values remain compatible.
- `noProgressTurns` is a positive safe integer and defaults to `3`. At the end of an automatic run, pi-goal compares visible assistant text after Unicode normalization, lowercasing, control-character removal, and whitespace collapse. Thinking and tool blocks are excluded; empty and punctuation-only output are equivalent. Consecutive empty or identical tool-free outputs increment the repeat count. Different non-empty output starts a new run at one, and any attempted tool call resets it. Set this field to `null` to disable only this heuristic.
- `minIntervalMs` is a non-negative safe integer and defaults to `0`.
  It delays normal settled continuation dispatch and the manual-compaction fallback from their eligible scheduling boundary, while `0` preserves immediate dispatch.

Settings are reread at Pi startup, session replacement, and `/reload`; direct external file edits are not watched live, while changes made through the Goal menu apply immediately. A missing file remains absent and uses the built-in defaults. The first successful settings change creates the file atomically; later saves preserve unknown fields.

Omitted fields use the defaults above. Invalid or malformed existing settings are never overwritten; they produce a warning and fall back to all defaults. In the TUI, Goal Settings becomes a read-only summary that identifies the invalid file and directs the user to fix it and run `/reload`. Reload Pi after changing the file. If a live runtime reloads settings, switching `toolVisibility` to `"always"`
restores only the exact tools that pi-goal previously hid, while switching to
`"after-first-goal"` locks a runtime that has no unfinished goal.

Tool visibility is a baseline, not ownership of Pi's global active-tool list. Plan mode or another restrictive policy may temporarily hide the tools. pi-goal does not fight that policy on restore or on every turn: activation is rejected if the required terminal tools cannot be made available, and an already-active goal is paused without automatic continuation if they disappear. A restrictive allowlist created before `goal_wait` existed can still run ordinary Goals with `goal_complete` and `goal_blocked`, but the model cannot enter external waiting until that allowlist also includes `goal_wait`. The pause aborts a Goal-owned kickoff, resume, active-edit, or automatic-continuation prompt, but it does not cancel or stale-block an unrelated user or extension turn, including startup follow-ups after a restrictive restore.

## 🚀 Commands

```text
/goal
/goal status
/goal implement snake game
/goal --tokens 100k fix the failing test and verify it
/goal edit ship the smaller fix first
/goal pause
/goal resume
/goal clear

# With experimental.goals enabled:
/goal add --tokens 20k run the integration tests
/goal prioritize fix the urgent production regression
/goal drop-last
/goal skip
```

- In the TUI, `/goal` opens a standard state-aware manager. Its first action follows the current
  state: start when empty, pause when active, review a reached automatic-work limit, resume for other
  stopped states, or increase an exhausted token budget. Active and paused views show **Automatic
  work: _used_ of _limit_ responses** with the remaining count, or explicitly show **Unlimited**.
  A hard-cap pause opens **Review and continue…**, which states that objective, cumulative usage,
  active time, and queue are preserved and previews that Continue resets the counter to zero and
  allows up to one more configured epoch. **Change automatic-work limit…** opens that setting while
  leaving the goal paused; Back and Escape make no change. **Start with token budget…** first offers
  `25k`, a suggested `100k`, `300k`, and **Set a custom budget…**, then collects the objective with
  the selected budget still visible. Custom input accepts examples such as `300000`, `300k`, `2.5k`,
  and `1.5m`; invalid input retains its draft for correction. Status, Settings, Help, queue
  management, invalid-settings guidance, Clear, and Close remain shallow, labeled routes. Arrow keys
  navigate, Enter selects or submits, Escape goes Back, and Ctrl+C closes the full flow.
- In RPC mode, bare `/goal` and `/goal status` report the current summary through an observable notification without opening terminal UI. Pi exposes no extension-command output channel in print or JSON mode, so those routes reject with an explicit unsupported-mode error instead of misreporting stderr as status output.
- Menu-driven Replace, Clear, Prioritize, Skip, and Drop last actions preview the exact affected goals and require confirmation. Existing direct routes remain immediate for compatibility and automation.
- `/goal <goal_to_complete>` starts goal mode. If another unfinished goal exists, Pi asks for confirmation before replacing it with a new active goal and resetting its usage counters. Failed kickoff delivery clears a new goal or restores the prior goal; a previously active goal is restored as paused.
- `/goal --tokens 100k <goal_to_complete>` starts or replaces goal mode with a token budget. `k` and `m` suffixes are accepted, for example `100k` or `1.5m`.
- `/goal edit <goal_to_complete>` updates the existing goal objective without resetting usage counters. A successful active edit rotates the stale-turn guard and starts a fresh safety epoch. Paused, blocked, and usage-limited goals stay stopped and retain their safety state until resume. A budget-limited goal reactivates only when `edit --tokens` raises its budget above current usage. Failed prompt delivery restores the exact previous safety counters/cause; it restores a budget-limited goal or restores and pauses a previously active goal.
- `/goal pause` stops prompt injection and auto-continuation, aborts the current turn, and keeps the goal for later resume. Only active goals can be paused.
- `/goal resume` resumes a paused, blocked, usage-limited, or budget-limited goal when its token budget allows it, rotates the stale-turn guard id, resets the automatic-response/repeat safety epoch when the queued resume prompt starts, clears a safety-pause cause, and reports the new finite epoch or explicit Unlimited state. Objective, cumulative usage, elapsed time, and queue are preserved. If prompt delivery fails, the original stopped state, guard id, counters, fingerprint, and cause are restored.
- `/goal clear` clears the current goal or the entire ordered queue, status, pending continuation/transition, and legacy persisted state for the current working directory without aborting unrelated in-flight work.

With `experimental.goals: true`:

- `/goal add [--tokens <budget>] <goal>` appends an objective without interrupting the active head. If no goal exists, it starts immediately.
- `/goal prioritize [--tokens <budget>] <goal>` inserts an urgent objective at the front. When Pi is busy, the intent is persisted and activation waits until the old run, retries, and pending messages settle, so old usage cannot be charged to the urgent goal.
- `/goal drop-last` removes the tail. If only the active head remains, it clears that goal.
- `/goal skip` removes the active head and starts the next eligible item only from an idle settled boundary. A stopped next item remains stopped.
- `push`, `unshift`, `pop`, and `shift` are accepted as aliases for `add`, `prioritize`, `drop-last`, and `skip`, respectively. Autocomplete shows only the intent-oriented names.
- `/goal <goal>` still starts or replaces the whole queue; `edit`, `pause`, and `resume` operate on the active head.

When the experiment is disabled, queue words retain the original parser behavior and are ordinary objective text. For example, `/goal add docs` starts the single objective `add docs`.

Goal objectives are limited to 4,000 characters. Put longer instructions in a file and reference the file path from `/goal`.

## 🔁 Session and reload behavior

Goal state is stored as Pi session state, similar to Codex's thread-owned goals. `/reload` and reopening the same Pi session can restore that session's unfinished goal. An active restored goal already at or above its finite automatic-work limit pauses before another provider request and reports that progress is saved; use `/goal` to review and continue. A restored waiting Goal remains quiet, excludes offline and waiting wall time from active elapsed time, and restores only its absolute optional deadline timer. With `"after-first-goal"`, an unfinished restore marks the tools unlocked in the new extension runtime, but it does not widen an active-tool set already restricted by an earlier lifecycle handler; an active goal instead restores as paused when either terminal tool is missing. If no unfinished goal remains, a fresh runtime starts locked again. Active elapsed time is checkpointed before shutdown and restarted after reload only when the Goal is not waiting, so offline and stopped wall-clock time is excluded. Automatic-response counts, repeat fingerprints, and safety-pause causes persist across reload and compaction. A direct non-`/goal` user/RPC input resets the safety epoch only while the goal is active and reclassifies the in-flight run as manual; extension input and messages sent while stopped do not reset it. Starting a new Pi session in the same working directory does not inherit the old goal.

Ordered queues use the same canonical `goal-state` session entry as single goals. Every item owns independent usage and safety state. Shelving, priority displacement, automatic advancement, and later reactivation preserve that item's epoch rather than granting more automatic work. The legacy `{ goal }` shape remains valid, and missing safety fields normalize to zero/defaults. Queue fields are written only when needed. Sessions created by the former standalone `pi-goals` experiment can migrate their last `goals-state` array and pending `unshift` intent when the branch has never written a canonical `goal-state`; any canonical entry, including an explicit clear, takes precedence so old plural state cannot be resurrected.

If a session still contains multiple goals or a pending queue transition when `experimental.goals` is disabled, pi-goal freezes that queue. It does not inject Goal prompts or continue work, reports `queue off`, preserves every item, and accepts only `/goal` for inspection or `/goal clear` for removal. Re-enabling the setting in the TUI resumes retained work after any aborted Goal-owned run settles; editing the file directly still requires `/reload`. A migrated legacy array containing only one goal becomes an ordinary single goal without requiring the experiment.

Older versions wrote unfinished goals to `~/.pi/agent/pi-goal-state.json` keyed by working directory. This version no longer reads that global file, and `/goal clear` removes any legacy entry for the current working directory.

## 📊 Statusline states

`pi-goal` writes compact plain status strings for statusline extensions. `@narumitw/pi-statusline` adds the default `🎯` icon unless configured otherwise:

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
- `queue off` — retained ordered goals are frozen because `experimental.goals` is disabled.

## 💰 Token budgets and elapsed time

The TUI budget chooser describes token budgets as cumulative Goal usage, warns that the final model
call may exceed the chosen value, and keeps the independent automatic-work response limit visible.
It is not a dollar-cost cap. Choosing a preset or entering a custom value remains provisional until
the objective is submitted; cancelling the chooser, custom input, or objective editor creates no
Goal. **Increase budget and resume…** shows the exact current budget and usage, requires a new total
above current usage, previews the new total plus automatic-work epoch, and resumes only after
confirmation. If the goal or its usage changes while that dialog is open, no change is applied.

For each persisted assistant message, `pi-goal` uses finite, non-negative `usage.totalTokens` when available. For compatibility with older or partial records, it otherwise sums finite, non-negative `input + output + cacheRead + cacheWrite`. It does not add `reasoning` because reasoning is already part of output, or `cacheWrite1h` because that is a subset of cache writes. Goal usage is the current branch's cumulative assistant total minus the baseline captured when the goal started, clamped at zero after branch rewinds.

Provider usage becomes authoritative only when an assistant message finishes, so a budget can overshoot by one model call. When completed tool activity first exposes exhaustion, the goal transitions once to `budget_limited`, cancels continuation, and queues one bounded custom wrap-up instruction before the next model call. The instruction permits only a concise progress/results/blockers summary; a substantive tool attempt is blocked and aborts the remaining wrap-up. A rejected `goal_complete` also terminates the wrap-up, while accepted completion still requires existing evidence that proves every requirement—budget exhaustion itself never means completion. If exhaustion is first visible at `agent_end` and no turn remains, the extension stops without creating another model turn.

The default 25-response automatic-work limit is a response-count boundary, not a fixed cost ceiling: context size, cache pricing, output length, and provider rates vary, and the final capped response is still retained. Pi derives displayed cost estimates from provider-reported token usage and local model pricing; pi-goal does not query a billing balance or enforce a dollar cap. For tighter token control, choose a smaller `automaticTurns` value and/or use `/goal --tokens`; choosing Unlimited removes only the response-count boundary.

Elapsed time is accumulated only while status is `active`. Pause, blocked, usage-limited, budget-limited, shutdown, and offline periods do not increase it. Legacy session entries are migrated by preserving their accumulated seconds and starting a fresh active clock when loaded.

## ✅ How completion works

While a goal is active, `pi-goal` injects persistence rules, a `<goal_id>` stale-turn guard, and exposes `goal_complete`. Kickoff, resume, edited-objective, system, and automatic-continuation prompts all place a trust boundary before the escaped objective, identifying it as user-provided task data; they preserve its full scope across turns and require the agent to derive concrete requirements from the objective and referenced artifacts. They treat the current worktree, command output, tests, runtime behavior, PR state, rendered artifacts, and external state as authoritative; previous conversation and plans are context rather than proof.

Before completion, the shared audit tells the agent to treat completion as unproven, inspect requirement-by-requirement evidence for every named artifact, command, test, gate, invariant, and deliverable, and match each check's scope to the requirement it supports. Weak, indirect, missing, or merely consistent evidence means work must continue. This prompt wording is a behavioral guardrail, not proof by itself: `pi-goal` can enforce the current goal id and reject empty or plainly contradictory summaries, but it cannot independently prove that external work is complete.

To finish, the agent must call `goal_complete` with the exact current `goal_id` and a `summary` of completion evidence. Missing or stale `goal_id` values are rejected before summary validation. Paused, blocked, and usage-limited goals cannot be completed until resumed; a budget-limited goal permits completion only during its bounded in-flight wrap-up. The summary is completion evidence, not the stale-turn safety token.

If a turn ends before completion, `pi-goal` records usage and creates one continuation intent unless a circuit breaker pauses it first.
It dispatches that continuation only after Pi's `agent_settled` lifecycle proves retries, automatic compaction, steering, and follow-up work have drained, `ctx.isIdle()` is true, and no messages are pending.
A configured `minIntervalMs` delay starts at that eligible settled scheduling boundary.
Repeated settled events cannot dispatch the same intent twice or restart its active delay.
Goal-owned kickoff, resume, active-edit, and automatic-continuation deliveries are bound to the goal instance that created them; a delayed prompt from a replaced goal is aborted without rolling back, injecting, or stopping the newer goal.
Plain assistant text never marks a goal complete—even an exact-reply objective pauses safely when the model repeatedly omits `goal_complete`.

Manual compaction does not emit `agent_settled`, so its completion hook uses the same single owned continuation timer as a narrow idle-only fallback and applies `minIntervalMs` from that eligible boundary.
Pi extensions cannot reserve an idle turn atomically like Codex core; another extension can still win the race after the idle check, and its newer turn supersedes the old continuation intent.

## ⏳ External waiting

Use `goal_wait` only after arranging a monitor or other wake source that will inject a non-Goal message when external state changes:

```text
goal_wait({
  goal_id: "<current-goal-id>",
  reason: "Waiting for the review monitor",
  resume_after_ms: 300000
})
```

`goal_id` must match the current active Goal, `reason` must contain 1–1,000 characters, and the optional `resume_after_ms` must be a whole number from 1 through 2,147,483,647. The deadline is a safety wake-up rather than a polling interval. Requests below 10,000 milliseconds are accepted for compatibility but clamped to an effective 10,000-millisecond deadline; the tool result reports both the requested and effective values. Prefer deadlines measured in minutes instead of repeated short wakes. Omitting `resume_after_ms` intentionally permits an indefinite quiet wait.

An accepted call keeps the canonical Goal status active, checkpoints active elapsed time, cancels pending continuation work, persists the reason and absolute optional deadline, and terminates the normal single-tool run. Call `goal_wait` alone because Pi only guarantees early termination when every finalized result in a parallel tool batch terminates.

Interactive input, RPC input, another extension's `sendUserMessage()` input, and supported non-Goal custom follow-ups clear the wait before their turn runs. pi-goal-owned kickoff, resume, edit, continuation, stale, or cancelled prompts do not count as external wake-ups. Pi does not expose the sending extension's identity, so any non-Goal extension message is treated as a wake signal.

After a waking turn ends, ordinary continuation rules apply again. The agent can complete or block the Goal, continue working, or call `goal_wait` again after arranging the next wake source. `/goal resume` also clears waiting and sends one manual resume prompt without resetting cumulative usage or the safety epoch. `/goal pause`, clear, edit, replace, completion, blocking, terminal limits, tool loss, queue displacement, session replacement, and shutdown cancel the in-memory deadline owner.

A future deadline is restored from its absolute timestamp after reload. Reload never restarts, extends, or newly clamps an already-persisted absolute deadline, including a short deadline written by an older version. An already-due deadline waits for Pi's settled, idle, no-pending-message boundary and then requests exactly one continuation through the normal dispatcher. If that delivery throws, pi-goal restores the wait, retries once after one second, and leaves the Goal visibly waiting after a second failure instead of retry-looping. A deadline never sends a prompt directly from a stale timer.

Waiting time is excluded from **Active elapsed**, while tokens, iteration, automatic-response count, no-progress state, queue data, and managed-run ownership remain preserved. The managed-run protocol continues reporting `active` because waiting is non-terminal. When an experimental priority Goal displaces a waiting head, the shelved Goal loses its wait so later reactivation performs a fresh external-state check.

## 🚧 Blocked goals

`goal_blocked` is intentionally narrower than completion or ordinary clarification. Every goal-mode prompt repeats the blocked audit: the model must provide the exact current `goal_id`, a specific reason describing the user or external action required (up to 1,000 characters), concrete evidence from the failed resolution attempts (up to 4,000 characters), and `repeated_turns` showing the same blocker recurred for at least three consecutive goal turns. A resumed goal starts a fresh blocker audit. Empty or oversized reasons/evidence, stale ids, non-whole turn counts, stopped goals, and fewer than three turns are rejected. Accepted blocker reports set `blocked`, stop automatic continuation, and terminate the tool batch when Pi can do so safely.

Do not use `goal_blocked` merely because work is difficult, incomplete, uncertain, awaiting normal clarification, or affected by a recoverable tool/provider failure. The user can resolve the external condition and run `/goal resume` to rotate the goal id and continue.

## 🛑 Interruption and queued-input behavior

A user pause or aborted turn produces `paused`; a terminal provider/account quota error produces `usage_limited`; another non-retryable agent error produces `blocked`. Each stopped transition cancels pending continuation intent or delivery, aborts stale work when applicable, and blocks stale tool calls until the next non-goal user prompt, successful reactivation/replacement, or `/goal clear`. On `/goal clear`, the extension clears goal state, continuation markers, and any stale tool-call block without aborting an unrelated in-flight turn. Retryable provider interruptions and overflow compaction retries stay `active` while Pi retries; no extra continuation is queued, and automatic ownership remains charged through retry `agent_start` events. If matching recovery still exists at `agent_settled`, retries are exhausted and the goal becomes `blocked` before any pending queue transition dispatches. Stale recovery cannot block a replacement goal. User and extension work that starts before settlement supersedes the older continuation intent, and pending messages always take priority.

## 🤝 Managed run RPC

With `rpc.enabled: true`, pi-goal exposes a session-local, dependency-free protocol over Pi's shared `pi.events` bus. It is intended for trusted sibling extensions that need to start, observe, and cancel one Goal lifecycle without driving the `/goal` command. Installed Pi extensions remain fully privileged: this setting controls only whether pi-goal cooperates with these channels and is not authentication or sandboxing.

The public channels are:

```text
pi-goal:start
pi-goal:cancel
pi-goal:event:${runId}
```

The protocol intentionally has no separate version field or versioned channel namespace. Before starting, the caller must generate a session-unique `runId`, subscribe to its event channel, and then emit:

```ts
pi.events.emit("pi-goal:start", {
  runId: "consumer-generated-run-id",
  objective: "Ship and verify the feature",
  tokenBudget: 100000, // optional positive integer
});
```

`runId` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; UUIDs are recommended. It is a correlation identifier, not a secret or authenticated caller identity. The objective uses the same 4,000-character validation as `/goal`, and `tokenBudget` is an absolute positive integer rather than a `k`/`m` string.

A successful start produces canonical state on `pi-goal:event:${runId}`:

```json
{
  "type": "state",
  "runId": "consumer-generated-run-id",
  "goalId": "<pi-goal-instance-id>",
  "status": "active"
}
```

Subsequent state events use `active`, `complete`, `blocked`, `paused`, `usage_limited`, `budget_limited`, or `cleared`. `complete` is the only successful terminal outcome. A matching completion may include `summary`; other terminal outcomes may include `reason`. Events come only from canonical Goal persistence and only for the matching managed run. Manual and restored Goals are not adopted or broadcast, unchanged persistence does not duplicate a status, and each run emits at most one terminal event.

Terminal events are dispatched after the underlying Goal transition settles, so a listener can start the next managed run directly after `complete` without re-entering completion cleanup. Other terminal statuses leave a stopped Goal that must be resolved or cleared first. If a manual edit, replacement, skip, or priority transition rotates the Goal id, the prior managed run ends as `cleared` with a superseded reason; the replacement remains outside that run.

To cancel before or after activation, emit the same `runId`:

```ts
pi.events.emit("pi-goal:cancel", {
  runId: "consumer-generated-run-id",
  reason: "Parent work was cancelled", // optional, at most 1,000 characters
});
```

Cancellation uses the normal Goal pause transition. It cannot affect a manual, restored, stale, or different run. The resulting `paused` state is the cancellation result; there is no separate reply envelope. A caller must not reopen a terminal `runId`, and a later manual `/goal resume` is outside that completed managed run.

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

Stable codes are `RPC_DISABLED`, `INVALID_REQUEST`, `NO_ACTIVE_SESSION`, `RUN_ID_IN_USE`, `RUN_NOT_FOUND`, `GOAL_ALREADY_EXISTS`, `ACTIVATION_FAILED`, and `SUPERSEDED`. Consumers branch on `code`; `message` is diagnostic. An unsafe or missing `runId` is ignored because there is no safe response channel.

Start never prompts for replacement: any pre-existing Goal is rejected. The protocol binds only after current settings and restored Goal state load, and unbinds before session shutdown. A caller must not assume that `emit()` waits for Goal completion; it should wait for a terminal run event and participate in its own session-shutdown cleanup.

This breaking contract replaces and removes `pi-goal:rpc:start`, `pi-goal:rpc:pause`, request-scoped start replies, and the global `pi-goal:state` broadcast. No compatibility aliases are registered.

## 🧠 Use cases

- Finish implementation tasks without stopping at a plan.
- Keep debugging until the bug is verified fixed.
- Run refactors that require multiple tool cycles.
- Encourage agents to test, lint, or typecheck before completion.
- Make long-running Pi coding sessions more autonomous.

## 🗂️ Package layout

```txt
packages/pi-goal/
├── src/
│   ├── index.ts      # Pi package entrypoint
│   ├── goal.ts       # Order-explicit extension composition root
│   ├── command-registration.ts # Lightweight slash-command adapter with lazy manager/settings UI
│   ├── commands.ts   # Per-factory user-command and queue mutation controller
│   ├── tools.ts      # Goal completion and blocker tool adapters
│   ├── lifecycle.ts  # Pi session, agent, tool, and compaction event adapter
│   ├── runtime.ts    # Per-factory Goal state, transitions, prompts, and budgets
│   ├── tool-policy.ts # Goal tool visibility ownership and rollback
│   ├── safety.ts     # Output normalization and no-progress fingerprint state
│   ├── wait.ts       # External-wait validation and session timer ownership
│   ├── errors.ts     # Pi-aligned provider error and retry classification
│   ├── markers.ts    # Bounded Goal prompt marker parsing and formatting
│   ├── run-protocol.ts # Default-off managed-run protocol and session ownership
│   ├── queue.ts      # Pure ordered-goal transitions
│   └── *.ts          # Package-local parsing, settings, prompts, accounting, and persistence
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

`index.ts` is the Pi entrypoint and forwards to `goal.ts`; the other source modules are internal. The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, goal mode, autonomous coding agent, AI agent workflow, task completion, agent loop, verification, TypeScript Pi package.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
