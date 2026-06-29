# 🎯 pi-goal — Goal Mode for the Pi Coding Agent

[![npm](https://img.shields.io/npm/v/@narumitw/pi-goal)](https://www.npmjs.com/package/@narumitw/pi-goal) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-goal` is a native [Pi coding agent](https://pi.dev) extension that adds session-scoped `/goal` commands and a `goal_complete` tool for autonomous, verifiable task completion.

Goal mode uses Codex-like persistence instructions and keeps sending guarded continuation messages until the agent calls `goal_complete`, the user pauses or clears the goal, an interrupt/error pauses the goal, or an optional token budget is reached.

## ✨ Features

- Adds `/goal <goal_to_complete>` to start goal mode, with confirmation before replacing an existing goal.
- Bare `/goal` shows the current goal summary.
- Keeps advanced goal management inside `/goal` subcommands: `pause`, `resume`, `clear`, and `edit`.
- Exposes only one top-level command: `/goal`.
- Supports optional token budgets such as `/goal --tokens 100k <goal>`.
- Tracks `active`, `paused`, `budget_limited`, and `complete` states.
- Stores goal state in the current Pi session, following Codex's thread-owned goal model instead of using a global per-directory goal.
- Registers a `goal_complete` tool for explicit completion, and rejects plainly contradictory completion summaries such as “not complete” or “tests still fail”.
- Automatically prompts the agent to continue if an active turn ends early, directly triggering the next turn when Pi is idle and no pending messages are queued.
- Pauses and aborts queued goal work when the user pauses a goal or Pi reports a non-retryable aborted/errored assistant turn.
- Keeps retryable provider interruptions and Pi compaction retries active without enqueueing duplicate goal continuations while Pi retries.
- Preserves active goals across manual, threshold, and overflow compaction.
- Guards auto-follow-ups so duplicate, replaced, paused, cleared, completed, or budget-limited goals are not continued.
- Blocks stale tool calls after pause or non-retryable interruption.
- Encourages requirement-by-requirement verification before the goal is marked complete.

## 📦 Install

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

- `/goal` shows the current goal, status, iteration count, elapsed time, token usage, and available `/goal` subcommands.
- `/goal <goal_to_complete>` starts goal mode. If another unfinished goal exists, Pi asks for confirmation before replacing it with a new active goal and resetting its usage counters.
- `/goal --tokens 100k <goal_to_complete>` starts or replaces goal mode with a token budget. `k` and `m` suffixes are accepted, for example `100k` or `1.5m`.
- `/goal edit <goal_to_complete>` updates the existing goal objective without resetting usage counters. Active goals stay active, paused goals stay paused, and budget-limited goals remain budget-limited if their budget is still exhausted.
- `/goal pause` stops prompt injection and auto-continuation, aborts the current turn, and keeps the goal for later resume.
- `/goal resume` resumes a paused or budget-limited goal when the token budget allows it, then queues a resume prompt so work continues.
- `/goal clear` clears the current goal state, status, pending continuation, and legacy persisted state for the current working directory without aborting any in-flight agent turn.

Goal objectives are limited to 4,000 characters. Put longer instructions in a file and reference the file path from `/goal`.

## 🔁 Session and reload behavior

Goal state is stored as Pi session state, similar to Codex's thread-owned goals. `/reload` and reopening the same Pi session can restore that session's unfinished goal. Starting a new Pi session in the same working directory does not inherit the old goal.

Older versions wrote unfinished goals to `~/.pi/agent/pi-goal-state.json` keyed by working directory. This version no longer reads that global file, and `/goal clear` removes any legacy entry for the current working directory.

## 📊 Statusline states

`pi-goal` writes compact plain status strings for statusline extensions. `@narumitw/pi-statusline` adds the default `🎯` icon unless configured otherwise:

- `active 3m` — an active goal without a token budget.
- `active 18k/100k` — an active goal with token usage and budget.
- `paused` — auto-continuation is paused.
- `budget 100k/100k` — the token budget was reached; auto-continuation stops.
- `complete` — shown briefly after `goal_complete` succeeds.

## ✅ How completion works

While a goal is active, `pi-goal` injects persistence rules and exposes `goal_complete`. If a turn ends before completion, it records usage and sends one guarded continuation only when no other messages are pending. Empty or plainly contradictory completion summaries are rejected as a state-safety guard, not as proof of completion.

## 🛑 Interruption and queued-input behavior

On user pause, abort, or non-retryable error, `pi-goal` pauses the goal, aborts stale work, and blocks stale tool calls until the next user prompt (non-extension input), `/goal resume`, or `/goal clear`. On `/goal clear`, it clears goal state, pending continuation markers, and any stale tool-call block; it does not abort the current turn. Retryable provider interruptions and overflow compaction retries stay active while Pi retries; no extra continuation is queued.

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
│   └── goal.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The package exposes its Pi extension through `package.json`:

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
