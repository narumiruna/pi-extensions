# 🎯 pi-goal — Goal Mode for the Pi Coding Agent

[![npm](https://img.shields.io/npm/v/@narumitw/pi-goal)](https://www.npmjs.com/package/@narumitw/pi-goal) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-goal` is a native [Pi coding agent](https://pi.dev) extension that adds session-scoped `/goal` commands, a `goal_complete({ goal_id, summary })` completion tool, and a strict `goal_blocked({ goal_id, reason, evidence, repeated_turns })` impasse tool for autonomous, verifiable task completion.

Goal mode uses Codex-like persistence instructions and sends guarded continuation messages from Pi's fully settled idle boundary until the agent completes the goal, the user pauses or clears it, a true blocker or provider usage limit stops it, or an optional token budget is reached.

## ✨ Features

- Adds `/goal <goal_to_complete>` to start goal mode, with confirmation before replacing an existing goal.
- Bare `/goal` shows the current goal summary.
- Keeps advanced goal management inside `/goal` subcommands: `pause`, `resume`, `clear`, and `edit`.
- Exposes only one top-level command: `/goal`.
- Supports optional token budgets such as `/goal --tokens 100k <goal>`, using provider-reported total-token accounting with a cache-inclusive compatibility fallback.
- Tracks distinct `active`, `paused`, `blocked`, `usage_limited`, `budget_limited`, and `complete` states.
- Stores goal state in the current Pi session, following Codex's thread-owned goal model instead of using a global per-directory goal.
- Registers a `goal_complete({ goal_id, summary })` tool for explicit completion, requiring the current goal id and rejecting missing/stale ids plus plainly contradictory summaries such as “not complete” or “tests still fail”.
- Registers `goal_blocked({ goal_id, reason, evidence, repeated_turns })` for true impasses only; it requires the current goal id, concrete evidence, and the same blocker recurring for at least three consecutive goal turns.
- Keeps both goal tools out of the model-visible active tool set until the first `/goal` activation or an unfinished goal is restored for the session; after that unlock they stay desired for the rest of the extension runtime, and each model turn reasserts the policy so other `setActiveTools` callers cannot permanently hide or prematurely expose them (avoids repeated goal-tool schema churn within the same runtime).
- Records continuation intent when an active turn ends early, then directly triggers exactly one next turn only after Pi reports the agent fully settled, idle, and free of pending messages.
- Lets retry, compaction, steering, follow-up, and other queued work settle before automatic goal continuation.
- Separates user interruption (`paused`), true impasse or terminal non-usage error (`blocked`), provider/account quota exhaustion (`usage_limited`), and user token budget exhaustion (`budget_limited`).
- Detects budget exhaustion after completed tool activity when assistant usage is persisted, then injects at most one non-user-authored wrap-up instruction and blocks further substantive tools.
- Keeps retryable provider interruptions and Pi compaction retries active without enqueueing duplicate goal continuations while Pi retries.
- Preserves active goals across manual, threshold, and overflow compaction.
- Guards auto-follow-ups so duplicate, replaced, stopped, cleared, completed, or budget-limited goals are not continued.
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

## 🚀 Commands

```text
/goal
/goal implement snake game
/goal --tokens 100k fix the failing test and verify it
/goal edit ship the smaller fix first
/goal pause
/goal resume
/goal clear
```

- `/goal` shows the current goal, status, iteration count, active elapsed time, token usage, and available `/goal` subcommands.
- `/goal <goal_to_complete>` starts goal mode. If another unfinished goal exists, Pi asks for confirmation before replacing it with a new active goal and resetting its usage counters. Failed kickoff delivery clears a new goal or restores the prior goal; a previously active goal is restored as paused.
- `/goal --tokens 100k <goal_to_complete>` starts or replaces goal mode with a token budget. `k` and `m` suffixes are accepted, for example `100k` or `1.5m`.
- `/goal edit <goal_to_complete>` updates the existing goal objective without resetting usage counters. Active goals stay active; paused, blocked, and usage-limited goals stay stopped. A budget-limited goal reactivates only when `edit --tokens` raises its budget above current usage. Failed prompt delivery restores a budget-limited goal or restores and pauses a previously active goal.
- `/goal pause` stops prompt injection and auto-continuation, aborts the current turn, and keeps the goal for later resume. Only active goals can be paused.
- `/goal resume` resumes a paused, blocked, usage-limited, or budget-limited goal when its token budget allows it, rotates the stale-turn guard id, and queues a resume prompt so work continues. If prompt delivery fails, the original stopped state and guard id are restored.
- `/goal clear` clears the current goal state, status, pending continuation, and legacy persisted state for the current working directory without aborting any in-flight agent turn.

Goal objectives are limited to 4,000 characters. Put longer instructions in a file and reference the file path from `/goal`.

## 🔁 Session and reload behavior

Goal state is stored as Pi session state, similar to Codex's thread-owned goals. `/reload` and reopening the same Pi session can restore that session's unfinished goal. Active elapsed time is checkpointed before shutdown and restarted after reload, so offline and stopped wall-clock time is excluded. Starting a new Pi session in the same working directory does not inherit the old goal.

Older versions wrote unfinished goals to `~/.pi/agent/pi-goal-state.json` keyed by working directory. This version no longer reads that global file, and `/goal clear` removes any legacy entry for the current working directory.

## 📊 Statusline states

`pi-goal` writes compact plain status strings for statusline extensions. `@narumitw/pi-statusline` adds the default `🎯` icon unless configured otherwise:

- `active 3m` — an active goal without a token budget; elapsed time counts only periods when its status is active.
- `active 18k/100k` — an active goal with token usage and budget.
- `paused` — the user paused or interrupted the goal.
- `blocked` — progress requires user or external action, or a terminal non-usage error stopped work.
- `usage` — the provider or account usage limit stopped work.
- `budget 100k/100k` — the user-configured token budget was reached; auto-continuation stops.
- `complete` — shown briefly after `goal_complete` succeeds.

## 💰 Token budgets and elapsed time

For each persisted assistant message, `pi-goal` uses finite, non-negative `usage.totalTokens` when available. For compatibility with older or partial records, it otherwise sums finite, non-negative `input + output + cacheRead + cacheWrite`. It does not add `reasoning` because reasoning is already part of output, or `cacheWrite1h` because that is a subset of cache writes. Goal usage is the current branch's cumulative assistant total minus the baseline captured when the goal started, clamped at zero after branch rewinds.

Provider usage becomes authoritative only when an assistant message finishes, so a budget can overshoot by one model call. When completed tool activity first exposes exhaustion, the goal transitions once to `budget_limited`, cancels continuation, and queues one bounded custom wrap-up instruction before the next model call. The instruction permits only a concise progress/results/blockers summary; a substantive tool attempt is blocked and aborts the remaining wrap-up. A rejected `goal_complete` also terminates the wrap-up, while accepted completion still requires existing evidence that proves every requirement—budget exhaustion itself never means completion. If exhaustion is first visible at `agent_end` and no turn remains, the extension stops without creating another model turn.

Elapsed time is accumulated only while status is `active`. Pause, blocked, usage-limited, budget-limited, shutdown, and offline periods do not increase it. Legacy session entries are migrated by preserving their accumulated seconds and starting a fresh active clock when loaded.

## ✅ How completion works

While a goal is active, `pi-goal` injects persistence rules, a `<goal_id>` stale-turn guard, and exposes `goal_complete`. Kickoff, resume, edited-objective, system, and automatic-continuation prompts all place a trust boundary before the escaped objective, identifying it as user-provided task data; they preserve its full scope across turns and require the agent to derive concrete requirements from the objective and referenced artifacts. They treat the current worktree, command output, tests, runtime behavior, PR state, rendered artifacts, and external state as authoritative; previous conversation and plans are context rather than proof.

Before completion, the shared audit tells the agent to treat completion as unproven, inspect requirement-by-requirement evidence for every named artifact, command, test, gate, invariant, and deliverable, and match each check's scope to the requirement it supports. Weak, indirect, missing, or merely consistent evidence means work must continue. This prompt wording is a behavioral guardrail, not proof by itself: `pi-goal` can enforce the current goal id and reject empty or plainly contradictory summaries, but it cannot independently prove that external work is complete.

To finish, the agent must call `goal_complete` with the exact current `goal_id` and a `summary` of completion evidence. Missing or stale `goal_id` values are rejected before summary validation. Paused, blocked, and usage-limited goals cannot be completed until resumed; a budget-limited goal permits completion only during its bounded in-flight wrap-up. The summary is completion evidence, not the stale-turn safety token.

If a turn ends before completion, `pi-goal` records usage and creates one continuation intent. It dispatches that continuation only from Pi's `agent_settled` lifecycle after retries, automatic compaction, steering, and follow-up work have drained, `ctx.isIdle()` is true, and no messages are pending. Repeated settled events cannot dispatch the same intent twice.

Manual compaction does not emit `agent_settled`, so its completion hook uses the same single-flight dispatcher as a narrow idle-only fallback. Pi extensions cannot reserve an idle turn atomically like Codex core; another extension can still win the race after the idle check, and its newer turn supersedes the old continuation intent.

## 🚧 Blocked goals

`goal_blocked` is intentionally narrower than completion or ordinary clarification. Every goal-mode prompt repeats the blocked audit: the model must provide the exact current `goal_id`, a specific reason describing the user or external action required (up to 1,000 characters), concrete evidence from the failed resolution attempts (up to 4,000 characters), and `repeated_turns` showing the same blocker recurred for at least three consecutive goal turns. A resumed goal starts a fresh blocker audit. Empty or oversized reasons/evidence, stale ids, non-whole turn counts, stopped goals, and fewer than three turns are rejected. Accepted blocker reports set `blocked`, stop automatic continuation, and terminate the tool batch when Pi can do so safely.

Do not use `goal_blocked` merely because work is difficult, incomplete, uncertain, awaiting normal clarification, or affected by a recoverable tool/provider failure. The user can resolve the external condition and run `/goal resume` to rotate the goal id and continue.

## 🛑 Interruption and queued-input behavior

A user pause or aborted turn produces `paused`; a terminal provider/account quota error produces `usage_limited`; another non-retryable agent error produces `blocked`. Each stopped transition cancels pending continuation intent or delivery, aborts stale work when applicable, and blocks stale tool calls until the next non-goal user prompt, successful reactivation/replacement, or `/goal clear`. On `/goal clear`, the extension clears goal state, continuation markers, and any stale tool-call block without aborting an unrelated in-flight turn. Retryable provider interruptions and overflow compaction retries stay `active` while Pi retries; no extra continuation is queued. User and extension work that starts before settlement supersedes the older continuation intent, and pending messages always take priority.

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
│   ├── goal.ts       # Pi entrypoint and shared lifecycle state machine
│   └── *.ts          # Package-local command, prompt, accounting, and persistence modules
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

Only `goal.ts` is a Pi entrypoint; the other source modules are internal. The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/goal.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, goal mode, autonomous coding agent, AI agent workflow, task completion, agent loop, verification, TypeScript Pi package.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
