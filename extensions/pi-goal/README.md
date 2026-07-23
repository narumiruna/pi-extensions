# 🎯 pi-goal — Goal Mode for the Pi Coding Agent

[![npm](https://img.shields.io/npm/v/@narumitw/pi-goal)](https://www.npmjs.com/package/@narumitw/pi-goal) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-goal` is a native [Pi coding agent](https://pi.dev) extension that adds session-scoped `/goal` commands, a `goal_complete({ goal_id, summary })` completion tool, and a strict `goal_blocked({ goal_id, reason, evidence, repeated_turns })` impasse tool for autonomous, verifiable task completion. An opt-in experimental mode adds an ordered queue without introducing a second command or tool namespace.

Goal mode uses Codex-like persistence instructions and sends guarded continuation messages from Pi's fully settled idle boundary until the agent completes the goal, the user pauses or clears it, a safety circuit breaker trips, a true blocker or provider usage limit stops it, or an optional token budget is reached. With ordered goals enabled, the same lifecycle advances through queued objectives one at a time.

## ✨ Features

- Adds `/goal <goal_to_complete>` to start goal mode, with confirmation before replacing an existing goal.
- Bare `/goal` shows the current goal summary.
- Keeps advanced goal management inside `/goal` subcommands: `pause`, `resume`, `clear`, and `edit`.
- Exposes only one top-level command: `/goal`, including when ordered goals are enabled.
- Optionally adds ordered-goal operations through `/goal add`, `prioritize`, `drop-last`, and `skip`, while accepting `push`, `unshift`, `pop`, and `shift` as hidden compatibility aliases.
- Bounds automatic work by default to 25 normal model responses, including responses inside automatic tool loops and Pi-owned retry/compaction recovery; set `continuationLimits.automaticTurns` explicitly to `null` only when unbounded automatic work is intended.
- Pauses after three consecutive empty or normalized-identical tool-free automatic runs, while distinct short output and tool activity reset the repeat detector.
- Supports optional token budgets such as `/goal --tokens 100k <goal>`, using provider-reported total-token accounting with a cache-inclusive compatibility fallback.
- Tracks distinct `active`, `paused`, `blocked`, `usage_limited`, `budget_limited`, and `complete` states.
- Stores goal state in the current Pi session, following Codex's thread-owned goal model instead of using a global per-directory goal. Experimental queues keep independent budget, usage, elapsed-time, iteration, status, and stale-id accounting for every item.
- Registers a `goal_complete({ goal_id, summary })` tool for explicit completion, requiring the current goal id and rejecting missing/stale ids plus plainly contradictory summaries such as “not complete” or “tests still fail”.
- Registers `goal_blocked({ goal_id, reason, evidence, repeated_turns })` for true impasses only; it requires the current goal id, concrete evidence, and the same blocker recurring for at least three consecutive goal turns.
- Keeps both goal tools active by default for a stable tool schema; optional `"after-first-goal"` visibility hides them until the first accepted `/goal` activation or an unfinished goal is restored, then keeps them desired for the rest of that extension runtime without overriding a restrictive restore policy.
- Records continuation and queue-transition intent, then triggers exactly one next turn only after Pi reports the agent fully settled, idle, and free of pending messages; if terminal tools disappear during a tool loop or before the next queued goal starts, pauses before another model turn.
- Lets retry, compaction, steering, follow-up, and other queued work settle before automatic goal continuation.
- Separates user interruption (`paused`), true impasse or terminal non-usage error (`blocked`), provider/account quota exhaustion (`usage_limited`), and user token budget exhaustion (`budget_limited`).
- Detects budget exhaustion after completed tool activity when assistant usage is persisted, then injects at most one non-user-authored wrap-up instruction and blocks further substantive tools.
- Keeps retryable provider interruptions and Pi compaction retries active without enqueueing duplicate goal continuations while Pi retries, then marks a matching unresolved error `blocked` only when `agent_settled` proves no retry, compaction, or follow-up remains.
- Preserves active goals across manual, threshold, and overflow compaction.
- Guards auto-follow-ups and Goal-owned kickoff deliveries so duplicate, replaced, stopped, cleared, completed, budget-limited, or stale queued prompts cannot continue or overwrite a newer goal.
- Rotates the completion guard id when a goal is resumed or edited so delayed old turns cannot complete the newer goal instance.
- Blocks stale tool calls after in-flight work pauses, blocks, or reaches a usage limit, until fresh non-goal user work, successful reactivation/replacement, or clear.
- Applies one evidence-based completion audit across kickoff, resume, edit, system, continuation, and budget-wrap-up prompts.

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
pi -e ./extensions/pi-goal
```

## ⚙️ Configuration

On the first session start, pi-goal automatically creates `~/.pi/agent/pi-goal.json`
with the complete current defaults:

```json
{
  "toolVisibility": "always",
  "experimental": {
    "goals": false
  },
  "continuationLimits": {
    "automaticTurns": 25,
    "noProgressTurns": 3
  }
}
```

Edit this generated file only when overriding the defaults.

`toolVisibility` accepts:

- `"always"` (default) — pi-goal does not proactively hide `goal_complete` or `goal_blocked`, keeping the tool schema stable from session startup.
- `"after-first-goal"` — hides both tools at fresh runtime startup, reveals them for the first accepted Goal activation, and treats an unfinished-goal restore as unlocked for the remainder of that extension runtime. On restore, pi-goal uses the active tools already established by earlier lifecycle handlers; it does not re-add missing terminal tools over a restrictive policy. Failed kickoff, replacement, resume, or reactivating-edit delivery restores the exact pre-activation tool set, including terminal tools exposed by another extension. If revealing the tools would widen an already-running turn, wait for Pi to become idle and retry `/goal`.

`experimental.goals` accepts a boolean and defaults to `false`. Set it to `true` to enable the ordered-goal subcommands and automatic queue advancement described below. Enabled sessions show one warning because command behavior and persisted queue state remain experimental.

`continuationLimits` controls the default-on runaway guards:

- `automaticTurns` is a positive safe integer and defaults to `25`. It counts every completed normal `turn_end` owned by automatically started Goal work, including model responses inside tool loops and matching Pi-owned retries. The user-triggered kickoff, resume, edit, and ordinary user runs are not charged. At the limit, the goal becomes `paused` with cause `continuation_limit`, pending continuation/recovery is cancelled, and the current operation is aborted. Pi may invoke a provider adapter once more with an already-aborted signal to produce its synthetic terminal event; that event is not counted and cannot resume Goal work. Set this field to `null` to remove the authoritative hard bound.
- `noProgressTurns` is a positive safe integer and defaults to `3`. At the end of an automatic run, pi-goal compares visible assistant text after Unicode normalization, lowercasing, control-character removal, and whitespace collapse. Thinking and tool blocks are excluded; empty and punctuation-only output are equivalent. Consecutive empty or identical tool-free outputs increment the repeat count. Different non-empty output starts a new run at one, and any attempted tool call resets it. Set this field to `null` to disable only this heuristic.

Settings are reread at Pi startup, session replacement, and `/reload`; the file is not watched live.
A missing file is created during any of those session starts, while an existing file is read without
being rewritten. Initialization publishes the generated file atomically and never overwrites a file
created concurrently by another process.

Omitted fields use the defaults above. Invalid or malformed existing settings are never overwritten;
they produce a warning and fall back to all defaults. If the default file cannot be created, pi-goal
warns, continues with the built-in defaults, and retries on the next session start. Reload Pi after
changing the file. If a live runtime reloads settings, switching `toolVisibility` to `"always"`
restores only the exact tools that pi-goal previously hid, while switching to
`"after-first-goal"` locks a runtime that has no unfinished goal.

Tool visibility is a baseline, not ownership of Pi's global active-tool list. Plan mode or another restrictive policy may temporarily hide the tools. pi-goal does not fight that policy on restore or on every turn: activation is rejected if both tools cannot be made available, and an already-active goal is paused without automatic continuation if they disappear. The pause aborts a Goal-owned kickoff, resume, active-edit, or automatic-continuation prompt, but it does not cancel or stale-block an unrelated user or extension turn, including startup follow-ups after a restrictive restore.

## 🚀 Commands

```text
/goal
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

- `/goal` shows the current goal, status, lifetime iteration count, automatic model-response count, active elapsed time, token usage, any safety-pause reason, and available `/goal` subcommands.
- `/goal <goal_to_complete>` starts goal mode. If another unfinished goal exists, Pi asks for confirmation before replacing it with a new active goal and resetting its usage counters. Failed kickoff delivery clears a new goal or restores the prior goal; a previously active goal is restored as paused.
- `/goal --tokens 100k <goal_to_complete>` starts or replaces goal mode with a token budget. `k` and `m` suffixes are accepted, for example `100k` or `1.5m`.
- `/goal edit <goal_to_complete>` updates the existing goal objective without resetting usage counters. A successful active edit rotates the stale-turn guard and starts a fresh safety epoch. Paused, blocked, and usage-limited goals stay stopped and retain their safety state until resume. A budget-limited goal reactivates only when `edit --tokens` raises its budget above current usage. Failed prompt delivery restores the exact previous safety counters/cause; it restores a budget-limited goal or restores and pauses a previously active goal.
- `/goal pause` stops prompt injection and auto-continuation, aborts the current turn, and keeps the goal for later resume. Only active goals can be paused.
- `/goal resume` resumes a paused, blocked, usage-limited, or budget-limited goal when its token budget allows it, rotates the stale-turn guard id, resets the automatic-response/repeat safety epoch, clears a safety-pause cause, and queues a resume prompt so work continues. If prompt delivery fails, the original stopped state, guard id, counters, fingerprint, and cause are restored.
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

Goal state is stored as Pi session state, similar to Codex's thread-owned goals. `/reload` and reopening the same Pi session can restore that session's unfinished goal. With `"after-first-goal"`, that unfinished restore marks the tools unlocked in the new extension runtime, but it does not widen an active-tool set already restricted by an earlier lifecycle handler; an active goal instead restores as paused when either terminal tool is missing. If no unfinished goal remains, a fresh runtime starts locked again. Active elapsed time is checkpointed before shutdown and restarted after reload, so offline and stopped wall-clock time is excluded. Automatic-response counts, repeat fingerprints, and safety-pause causes persist across reload and compaction. A direct non-`/goal` user/RPC input resets the safety epoch only while the goal is active and reclassifies the in-flight run as manual; extension input and messages sent while stopped do not reset it. Starting a new Pi session in the same working directory does not inherit the old goal.

Ordered queues use the same canonical `goal-state` session entry as single goals. Every item owns independent usage and safety state. Shelving, priority displacement, automatic advancement, and later reactivation preserve that item's epoch rather than granting more automatic work. The legacy `{ goal }` shape remains valid, and missing safety fields normalize to zero/defaults. Queue fields are written only when needed. Sessions created by the former standalone `pi-goals` experiment can migrate their last `goals-state` array and pending `unshift` intent when the branch has never written a canonical `goal-state`; any canonical entry, including an explicit clear, takes precedence so old plural state cannot be resurrected.

If a session still contains multiple goals or a pending queue transition when `experimental.goals` is disabled, pi-goal freezes that queue. It does not inject Goal prompts or continue work, reports `queue off`, preserves every item, and accepts only `/goal` for inspection or `/goal clear` for removal. Re-enable the setting and run `/reload` to resume. A migrated legacy array containing only one goal becomes an ordinary single goal without requiring the experiment.

Older versions wrote unfinished goals to `~/.pi/agent/pi-goal-state.json` keyed by working directory. This version no longer reads that global file, and `/goal clear` removes any legacy entry for the current working directory.

## 📊 Statusline states

`pi-goal` writes compact plain status strings for statusline extensions. `@narumitw/pi-statusline` adds the default `🎯` icon unless configured otherwise:

- `active 3m` — an active goal without a token budget; elapsed time counts only periods when its status is active.
- `active 18k/100k` — an active goal with token usage and budget.
- `paused` — the user paused/interrupted the goal, terminal tools disappeared, or a `continuation_limit`/`no_progress` safety breaker stopped automatic work. Bare `/goal` shows the fixed safety reason and counters.
- `blocked` — progress requires user or external action, or a terminal non-usage error stopped work.
- `usage` — the provider or account usage limit stopped work.
- `budget 100k/100k` — the user-configured token budget was reached; auto-continuation stops.
- `complete` — shown briefly after `goal_complete` succeeds.
- `queue off` — retained ordered goals are frozen because `experimental.goals` is disabled.

## 💰 Token budgets and elapsed time

For each persisted assistant message, `pi-goal` uses finite, non-negative `usage.totalTokens` when available. For compatibility with older or partial records, it otherwise sums finite, non-negative `input + output + cacheRead + cacheWrite`. It does not add `reasoning` because reasoning is already part of output, or `cacheWrite1h` because that is a subset of cache writes. Goal usage is the current branch's cumulative assistant total minus the baseline captured when the goal started, clamped at zero after branch rewinds.

Provider usage becomes authoritative only when an assistant message finishes, so a budget can overshoot by one model call. When completed tool activity first exposes exhaustion, the goal transitions once to `budget_limited`, cancels continuation, and queues one bounded custom wrap-up instruction before the next model call. The instruction permits only a concise progress/results/blockers summary; a substantive tool attempt is blocked and aborts the remaining wrap-up. A rejected `goal_complete` also terminates the wrap-up, while accepted completion still requires existing evidence that proves every requirement—budget exhaustion itself never means completion. If exhaustion is first visible at `agent_end` and no turn remains, the extension stops without creating another model turn.

The automatic-response cap is a call-count boundary, not a fixed cost ceiling: context size, cache pricing, output length, and provider rates vary, and the 25th response is still retained. No default token budget is imposed. For stricter spend control, combine the default circuit breakers with `/goal --tokens`.

Elapsed time is accumulated only while status is `active`. Pause, blocked, usage-limited, budget-limited, shutdown, and offline periods do not increase it. Legacy session entries are migrated by preserving their accumulated seconds and starting a fresh active clock when loaded.

## ✅ How completion works

While a goal is active, `pi-goal` injects persistence rules, a `<goal_id>` stale-turn guard, and exposes `goal_complete`. Kickoff, resume, edited-objective, system, and automatic-continuation prompts all place a trust boundary before the escaped objective, identifying it as user-provided task data; they preserve its full scope across turns and require the agent to derive concrete requirements from the objective and referenced artifacts. They treat the current worktree, command output, tests, runtime behavior, PR state, rendered artifacts, and external state as authoritative; previous conversation and plans are context rather than proof.

Before completion, the shared audit tells the agent to treat completion as unproven, inspect requirement-by-requirement evidence for every named artifact, command, test, gate, invariant, and deliverable, and match each check's scope to the requirement it supports. Weak, indirect, missing, or merely consistent evidence means work must continue. This prompt wording is a behavioral guardrail, not proof by itself: `pi-goal` can enforce the current goal id and reject empty or plainly contradictory summaries, but it cannot independently prove that external work is complete.

To finish, the agent must call `goal_complete` with the exact current `goal_id` and a `summary` of completion evidence. Missing or stale `goal_id` values are rejected before summary validation. Paused, blocked, and usage-limited goals cannot be completed until resumed; a budget-limited goal permits completion only during its bounded in-flight wrap-up. The summary is completion evidence, not the stale-turn safety token.

If a turn ends before completion, `pi-goal` records usage and creates one continuation intent unless a circuit breaker pauses it first. It dispatches that continuation only from Pi's `agent_settled` lifecycle after retries, automatic compaction, steering, and follow-up work have drained, `ctx.isIdle()` is true, and no messages are pending. Repeated settled events cannot dispatch the same intent twice. Goal-owned kickoff, resume, active-edit, and automatic-continuation deliveries are bound to the goal instance that created them; a delayed prompt from a replaced goal is aborted without rolling back, injecting, or stopping the newer goal. Plain assistant text never marks a goal complete—even an exact-reply objective pauses safely when the model repeatedly omits `goal_complete`.

Manual compaction does not emit `agent_settled`, so its completion hook uses the same single-flight dispatcher as a narrow idle-only fallback. Pi extensions cannot reserve an idle turn atomically like Codex core; another extension can still win the race after the idle check, and its newer turn supersedes the old continuation intent.

## 🚧 Blocked goals

`goal_blocked` is intentionally narrower than completion or ordinary clarification. Every goal-mode prompt repeats the blocked audit: the model must provide the exact current `goal_id`, a specific reason describing the user or external action required (up to 1,000 characters), concrete evidence from the failed resolution attempts (up to 4,000 characters), and `repeated_turns` showing the same blocker recurred for at least three consecutive goal turns. A resumed goal starts a fresh blocker audit. Empty or oversized reasons/evidence, stale ids, non-whole turn counts, stopped goals, and fewer than three turns are rejected. Accepted blocker reports set `blocked`, stop automatic continuation, and terminate the tool batch when Pi can do so safely.

Do not use `goal_blocked` merely because work is difficult, incomplete, uncertain, awaiting normal clarification, or affected by a recoverable tool/provider failure. The user can resolve the external condition and run `/goal resume` to rotate the goal id and continue.

## 🛑 Interruption and queued-input behavior

A user pause or aborted turn produces `paused`; a terminal provider/account quota error produces `usage_limited`; another non-retryable agent error produces `blocked`. Each stopped transition cancels pending continuation intent or delivery, aborts stale work when applicable, and blocks stale tool calls until the next non-goal user prompt, successful reactivation/replacement, or `/goal clear`. On `/goal clear`, the extension clears goal state, continuation markers, and any stale tool-call block without aborting an unrelated in-flight turn. Retryable provider interruptions and overflow compaction retries stay `active` while Pi retries; no extra continuation is queued, and automatic ownership remains charged through retry `agent_start` events. If matching recovery still exists at `agent_settled`, retries are exhausted and the goal becomes `blocked` before any pending queue transition dispatches. Stale recovery cannot block a replacement goal. User and extension work that starts before settlement supersedes the older continuation intent, and pending messages always take priority.

## 🤝 Cross-extension RPC and events

pi-goal exposes a session-local, dependency-free integration contract over Pi's shared `pi.events` bus so sibling extensions (such as `@tintinweb/pi-subagents`) can start, pause, and observe goals programmatically without driving the `/goal` slash command. The contract is bound only while a Pi session is active: it is established on `session_start` and the captured session context is unbound on `session_shutdown`. All channels are plain JSON-shaped payloads; this extension never adds a runtime dependency for them.

### Starting a goal: `pi-goal:rpc:start`

Emit `pi-goal:rpc:start` with `{ requestId: string, objective: string, tokenBudget?: number }`. `tokenBudget` is an absolute positive integer token count (for example `100000`), not a `k`/`m` string. The request reuses the same `startGoal()` transition as the slash command, so it never implements goal transitions twice.

pi-goal replies on `pi-goal:rpc:start:reply:${requestId}` with one of:

```jsonc
// success
{ "success": true, "data": { "goalId": "<uuid>", "status": "active" } }
// failure (validation, no session, pre-existing goal, or failed activation)
{ "success": false, "error": "<human-readable reason>" }
```

Behavior notes:

- Malformed payloads (missing/empty/non-string `objective`, or a non-positive-integer `tokenBudget`) fail fast with a descriptive `error`.
- If no session context is bound (before `session_start` or after `session_shutdown`), the reply is a failure rather than starting a goal.
- RPC starts run in a fresh child context, so a **pre-existing goal fails** instead of prompting, replacing, or reusing stale state. Clear the existing goal first.
- The reply `status` is read from the authoritative goal state, so an immediate terminal outcome during start is represented rather than assumed to be `active`.

### Pausing a goal: `pi-goal:rpc:pause`

Emit `pi-goal:rpc:pause` with `{ goalId?: string, requestId?: string, reason?: string }` to stop an active RPC-owned goal safely. After a successful start reply, pass its `goalId`. To cancel while the start reply is still pending, omit `goalId` and pass the originating start `requestId`. Uncorrelated requests, stale request IDs, mismatched goal IDs, and goals not created through RPC are ignored. A successful pause uses the normal Goal pause transition and emits the authoritative `pi-goal:state` event described below.

### Observing goal state: `pi-goal:state`

Whenever pi-goal persists canonical goal state, it emits `pi-goal:state` with `{ goalId, status, summary?, reason? }`. `goalId` and `status` are always authoritative. Terminal statuses are `complete`, `blocked`, `paused`, `usage_limited`, `budget_limited`, and `cleared`. Explicit clears and failed activation rollbacks emit `cleared` for the removed goal so observers cannot retain stale active state. `summary` is populated from the matching `goal_complete` summary when available, and `reason` is populated from the same goal instance's blocked/usage/budget/clear state where available; an `active` or `queued` event carries only `goalId` and `status`. Listeners must treat any non-terminal status as in-progress and should key follow-up behavior on `goalId` plus a terminal `status`.

## 🧠 Use cases

- Finish implementation tasks without stopping at a plan.
- Keep debugging until the bug is verified fixed.
- Run refactors that require multiple tool cycles.
- Encourage agents to test, lint, or typecheck before completion.
- Make long-running Pi coding sessions more autonomous.

## 🗂️ Package layout

```txt
extensions/pi-goal/
├── src/
│   ├── index.ts      # Pi package entrypoint
│   ├── goal.ts       # Tool contracts and lifecycle orchestration
│   ├── commands.ts   # Per-factory user-command and queue mutation controller
│   ├── runtime.ts    # Per-factory state, prompt ownership, budgets, and tool policy
│   ├── safety.ts     # Output normalization and no-progress fingerprint state
│   ├── errors.ts     # Pi-aligned provider error and retry classification
│   ├── markers.ts    # Bounded Goal prompt marker parsing and formatting
│   ├── rpc.ts        # Session-local cross-extension request ownership and replies
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
