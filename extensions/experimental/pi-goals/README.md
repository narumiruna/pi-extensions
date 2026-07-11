# 🎯 pi-goals — Experimental Ordered Goal Arrays

[![Experimental](https://img.shields.io/badge/status-experimental-orange.svg)](#-experimental-use-and-distribution) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

> [!WARNING]
> `pi-goals` is an experimental Pi extension. Behavior, commands, and persisted state may change without compatibility guarantees.

`pi-goals` runs an ordered array of goals to verified completion. It provides `/goals`, `goals_complete`, and `goals_blocked` without depending on or modifying `pi-goal`.

## ✨ Features

- Manages a session-scoped ordered goal array through `/goals`.
- Uses TypeScript-array-style `push`, `unshift`, `pop`, and `shift` operations.
- Automatically advances after verified completion only when Pi reaches its settled idle boundary.
- Gives every goal independent token usage, optional budget, active elapsed time, iteration count, status, and stale-turn guard id.
- Preserves paused, blocked, usage-limited, and budget-limited states when a goal is displaced and later restored.
- Persists the array in the current Pi session under an independent `goals-state` entry.
- Uses distinct `/goals`, `goals_complete`, `goals_blocked`, and `goals` status identifiers so it can be loaded alongside `pi-goal`.
- Preserves active goals across manual, threshold, and overflow compaction.
- Defers continuation until retry, compaction, steering, follow-up, and other queued work have settled.
- Enforces bounded budget wrap-up and stale tool-call guards.

## 🧪 Experimental use and distribution

Requires Pi `0.80.6` or newer for the `agent_settled` lifecycle event. From a local repository checkout:

```bash
npm install
pi -e ./extensions/experimental/pi-goals
```

The equivalent repository recipe is `just try-goals`. It is intentionally excluded from `just try-all`.

Experimental packages are excluded from `publish-all`, shared version bumps, and GitHub publish workflows. A maintainer may manually publish the current version with:

```bash
just publish goals
```

If that version is available on npm, users can install it with `pi install npm:@narumitw/pi-goals`. Publication and compatibility are not guaranteed.

## 🚀 Commands

```text
/goals
/goals implement the first task
/goals --tokens 100k fix and verify the regression
/goals push run the integration tests
/goals unshift fix the urgent production regression
/goals pop
/goals shift
/goals edit revise the active objective
/goals pause
/goals resume
/goals clear
```

- `/goals` shows the active goal and the ordered array with each item's status.
- `/goals <goal>` starts a new array. Replacing an existing array requires confirmation and clears its queued goals.
- `/goals --tokens <budget> <goal>` starts with an optional budget; integer values and `k`/`m` suffixes are accepted.
- `/goals push [--tokens <budget>] <goal>` appends a goal without interrupting the active head.
- `/goals unshift [--tokens <budget>] <goal>` inserts an urgent head. If Pi is busy, activation waits until the current run and queued work fully settle, preventing the old run from charging or mutating the urgent goal.
- `/goals pop` removes the tail. If only the active goal remains, the array becomes empty.
- `/goals shift` removes the head and activates the next eligible goal.
- `/goals edit <goal>` edits only the active head while preserving its accounting.
- `/goals pause` and `/goals resume` operate only on the active head.
- `/goals clear` removes the whole array without aborting unrelated in-flight work.

Goal objectives are limited to 4,000 characters. Put longer instructions in a file and reference that path from `/goals`.

## 🔁 Ordering and activation

The first array item is the active head. Later items use `queued` status until activated. `push` appends work; `unshift` preempts by shelving the old head at index 1 after any in-flight run settles; `pop` removes the final item; and `shift` removes the head.

`goals_complete({ goal_id, summary })` marks only the current head complete. When another item exists, the extension records an advance intent and waits for `agent_settled`, `ctx.isIdle()`, and an empty pending-message queue before activation. This prevents the completed run's later lifecycle events from incrementing or stopping the next goal.

A newly activated queued goal receives a fresh `goal_id`. If a displaced goal was paused, blocked, usage-limited, or budget-limited, it retains that state and waits for `/goals resume` or an eligible budget edit instead of starting automatically.

## ✅ Completion and blocking

Every goal prompt includes the current `<goal_id>` stale-turn guard and a requirement-by-requirement verification audit.

- Call `goals_complete({ goal_id, summary })` only after authoritative evidence proves the active goal is fully complete.
- Call `goals_blocked({ goal_id, reason, evidence, repeated_turns })` only for a true user/external impasse observed over at least three consecutive goal turns.
- Missing, stale, empty, contradictory, or otherwise invalid reports are rejected.
- Completing or removing one goal never permits an old turn to complete the next one.

## 💰 Token budgets and elapsed time

Each goal owns independent accounting. Provider-reported `usage.totalTokens` is preferred; older records fall back to finite non-negative `input + output + cacheRead + cacheWrite`. Tokens spent while an urgent head runs do not consume a displaced goal's budget.

Active elapsed time excludes queued, paused, blocked, usage-limited, budget-limited, shutdown, and offline periods. A budget can overshoot by one model call because usage becomes authoritative only after an assistant message finishes. At exhaustion, `pi-goals` permits at most one bounded summary wrap-up and blocks substantive tools.

## 🔁 Session behavior

The ordered array is stored in `goals-state` custom entries owned by the current Pi session. Reloading or reopening that session restores the array. Starting a different session in the same directory does not inherit it.

## 📊 Statusline states

`pi-goals` writes compact text to the `goals` status key:

- `active 3m`
- `active 18k/100k`
- `paused`
- `blocked`
- `usage`
- `budget 100k/100k`
- `complete` (briefly after the last goal completes)

## ⚠️ Coexistence with pi-goal

`pi-goals` and `pi-goal` can be loaded together because their command, tool, status, continuation-marker, custom-message, and session-entry identifiers are distinct. Do not keep `/goal` and `/goals` loops active at the same time: both are autonomous and can legitimately inject continuation work into the same conversation.

## 🗂️ Package layout

```text
extensions/experimental/pi-goals/
├── src/
│   ├── goals.ts
│   ├── accounting.ts
│   ├── command.ts
│   ├── persistence.ts
│   └── prompts.ts
├── test/
│   ├── goals.test.ts
│   ├── goals-queue.test.ts
│   └── goals-runtime-smoke.mjs
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

Only `goals.ts` is a Pi entrypoint; the other source modules are package-local implementation details.

## 🔎 Keywords

Experimental Pi extension, Pi coding agent, goal array, goal queue, autonomous coding agent, verified completion, local development, TypeScript.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
