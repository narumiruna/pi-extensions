# 🎯 pi-goal — Goal Mode for the Pi Coding Agent

[![npm](https://img.shields.io/npm/v/@narumitw/pi-goal)](https://www.npmjs.com/package/@narumitw/pi-goal) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-goal` is a native [Pi coding agent](https://pi.dev) extension that adds session-scoped `/goal` commands and a `goal_complete` tool for autonomous, verifiable task completion.

Goal mode keeps sending guarded automatic follow-up messages until the agent calls `goal_complete`, the user pauses or clears the goal, or an optional token budget is reached.

## ✨ Features

- Adds `/goal <goal_to_complete>` to start goal mode, with confirmation before replacing an existing goal.
- Bare `/goal` shows the current goal summary.
- Keeps advanced goal management inside `/goal` subcommands: `pause`, `resume`, `clear`, and `edit`.
- Exposes only one top-level command: `/goal`.
- Supports optional token budgets such as `/goal --tokens 100k <goal>`.
- Tracks `active`, `paused`, `budget_limited`, and `complete` states.
- Keeps goal state in the current Pi runtime by default, so `/reload` or restarting Pi starts without an active goal.
- Registers a `goal_complete` tool for explicit completion.
- Automatically prompts the agent to continue if an active turn ends early.
- Guards auto-follow-ups so replaced, paused, cleared, completed, or budget-limited goals are not continued.
- Encourages verification before the goal is marked complete.

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
- `/goal pause` stops prompt injection and auto-continuation without forgetting the goal.
- `/goal resume` resumes a paused or budget-limited goal when the token budget allows it.
- `/goal clear` cancels the current goal and also removes any legacy persisted state for the current working directory.

Goal objectives are limited to 4,000 characters. Put longer instructions in a file and reference the file path from `/goal`.

## 🔁 Session and reload behavior

By default, goal state is scoped to the current Pi runtime. `/reload` or restarting Pi does not restore an unfinished goal, even if an older version left state in `~/.pi/agent/pi-goal-state.json`.

If you explicitly want legacy cross-reload persistence, start Pi with `PI_GOAL_PERSIST=1`. When persistence is enabled, unfinished goals are stored per working directory under the Pi agent config directory. `/goal clear` removes the stored goal for the current working directory.

## 📊 Statusline states

`pi-goal` writes compact status strings for statusline extensions:

- `🎯 active 3m` — an active goal without a token budget.
- `🎯 active 18k/100k` — an active goal with token usage and budget.
- `🎯 paused` — auto-continuation is paused.
- `🎯 budget 100k/100k` — the token budget was reached; auto-continuation stops.
- `🎯 complete` — shown briefly after `goal_complete` succeeds.

## ✅ How completion works

The extension registers a `goal_complete` tool. While a goal is active, the system prompt tells the agent to keep working, verify the result, and call `goal_complete` only when the goal is fully done.

If an agent turn ends before `goal_complete` is called, the extension records elapsed time and token usage, checks the budget, verifies that the same goal id is still active, then sends a follow-up prompt to continue the same goal.

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
