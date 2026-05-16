## Goal

Evolve `@narumitw/pi-goal` from an in-memory auto-continue loop into a more durable goal-mode extension inspired by Codex thread goals, while preserving the current simple `/goal <objective>` workflow and explicit `goal_complete` tool completion.

Success means `pi-goal` supports bounded, inspectable, resumable goal state with clear user controls, protects against stale continuations, and exposes compact status information for `pi-statusline`.

## Context

Current `pi-goal` implementation is in `extensions/pi-goal/src/goal.ts` and keeps a module-level `activeGoal` with `{ text, startedAt, iteration }`. It registers:

- `/goal <goal_to_complete>` to start goal mode.
- `/goal-status` to show active goal.
- `/goal-stop` to clear active goal.
- `goal_complete` to mark success and terminate the turn.
- `before_agent_start` prompt injection and `agent_end` auto-follow-up.

Codex references inspected under `third_party/codex/codex-rs/`:

- `state/src/model/thread_goal.rs`: durable `ThreadGoal` model with `goal_id`, `objective`, `status`, `token_budget`, `tokens_used`, and `time_used_seconds`.
- `state/src/runtime/goals.rs`: replace/insert/update/delete goal operations, budget-limited status, expected-goal-id guard, and usage accounting.
- `protocol/src/protocol.rs`: objective validation and `ThreadGoalUpdated` event payload.
- `tui/src/app/thread_goal_actions.rs`: `/goal`, `/goal edit`, `/goal clear`, `/goal pause`, `/goal resume`, replace confirmation, and status feedback.
- `tui/src/chatwidget/goal_status.rs`: compact status indicator with active/paused/budget-limited/complete display.

## Architecture

Keep `pi-goal` self-contained as a TypeScript Pi extension. Introduce a small goal state model and state transition helpers inside `extensions/pi-goal/src/goal.ts` or a nearby `src/state.ts` if the file becomes too large.

Suggested model:

```ts
type GoalStatus = "active" | "paused" | "budget_limited" | "complete";

interface ActiveGoal {
  id: string;
  text: string;
  status: GoalStatus;
  startedAt: number;
  updatedAt: number;
  iteration: number;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
}
```

Use `id` as a stale-continuation guard. Any auto-follow-up or `goal_complete` action should check that it still applies to the current goal id before changing state.

## Non-Goals

- Do not port Codex's SQLite-backed thread store into Pi.
- Do not change Pi core session storage APIs.
- Do not remove the existing `goal_complete` tool or the basic `/goal <objective>` UX.
- Do not implement exact Codex UI popups; use Pi extension commands and notifications.

## Assumptions

- Pi extension module state is enough for the first implementation slice; durable session persistence can be added through Pi session entries or extension state once the desired API is confirmed.
- Token usage can be estimated from existing session assistant usage entries, similar to how `pi-statusline` computes totals.
- `pi-statusline` will consume `ctx.ui.setStatus("goal", ...)` strings rather than a structured goal API.

## Unknowns

- Which Pi persistence API is best for cross-session goal state: session entries, settings-like extension state, or a new extension-owned file. Resolve before implementing durable resume.
- Whether `goal_complete` can reliably receive enough context to verify the active `goal_id`, or whether the completion tool parameters should include an optional hidden/current id. Resolve in the stale-continuation slice.

## Plan

- [x] Add goal status model and pure state transition helpers for `active`, `paused`, `budget_limited`, and `complete`; verified with `npm run typecheck --workspace @narumitw/pi-goal` and `npm run check`.
- [x] Replace the old `activeGoal.text/iteration`-only status strings with compact status output such as `goal: active 3m`, `goal: paused`, and `goal: budget 18k/100k`; verified by inspecting `ctx.ui.setStatus("goal", ...)` call sites in `extensions/pi-goal/src/goal.ts`.
- [x] Extend `/goal` command parsing so bare `/goal` shows the current goal summary, while `/goal <objective>` starts a goal only after checking whether another goal exists; verified by code paths and typecheck.
- [x] Add `/goal pause`, `/goal resume`, `/goal clear`, and `/goal edit <objective>` subcommands while keeping `/goal-status` and `/goal-stop` as compatibility aliases; verified by README command examples and typecheck.
- [x] Add objective validation with a 4,000-character limit and a hint to put long instructions in a file; verified by parser/validation code and typecheck.
- [x] Add optional token budget parsing for `/goal --tokens 100k <objective>` with `k`/`m` suffix support; verified parser code supports `100k`, `1.5m`, invalid values, and plain objectives beginning with non-budget flags.
- [x] Account token and elapsed-time usage after each agent turn and transition active goals to `budget_limited` when `tokensUsed >= tokenBudget`; verified by code path and typecheck.
- [x] Guard auto-follow-ups with `goal.id` so stale `agent_end` continuations cannot continue a replaced, paused, cleared, completed, or budget-limited goal; verified by guarded code path and typecheck.
- [x] Persist enough goal state to survive `/resume` or Pi restart via an extension-owned state file under the Pi agent config directory, keyed by working directory; verified by load/persist code paths and typecheck.
- [x] Update `extensions/pi-goal/README.md` with the new command namespace, status meanings, budget examples, and compatibility aliases; verified with `npm run check`.
- [x] Preview package contents with `just pack-goal` to confirm only intended files are shipped.

## Risks

- Auto-continuation can become annoying or costly if pause/budget checks are incomplete.
- Token accounting may drift if provider usage fields differ from the statusline assumptions.
- Command parsing can break existing `/goal <objective>` behavior if subcommands or flags are parsed too eagerly.
- Durable persistence may require deeper Pi APIs than this extension currently uses.

## Rollback / Recovery

If the new goal state machine causes bad auto-follow-up behavior, revert to the prior in-memory `activeGoal` loop by restoring `extensions/pi-goal/src/goal.ts` from the previous release and republishing a patch version. Keep compatibility commands (`/goal-status`, `/goal-stop`) during the migration so users can stop goals even if new subcommands are confusing.

## Completion Checklist

- [x] `pi-goal` supports `active`, `paused`, `budget_limited`, and `complete` statuses, verified by code paths and `npm run typecheck --workspace @narumitw/pi-goal`.
- [x] `/goal`, `/goal pause`, `/goal resume`, `/goal clear`, and `/goal edit` are implemented in the command dispatcher, verified by code review and typecheck.
- [x] Existing `/goal <objective>`, `/goal-status`, `/goal-stop`, and `goal_complete` remain compatible, verified by compatibility aliases and typecheck.
- [x] Stale continuations cannot mutate or continue a replaced/cleared/completed goal, verified by goal-id/status guards in the `agent_end` path.
- [x] Token budget behavior reaches `budget_limited` and stops auto-continuation, verified by budget check in the `agent_end` path.
- [x] Goal status strings are compact and useful for `pi-statusline`, verified by inspecting `ctx.ui.setStatus("goal", ...)` output examples.
- [x] README documentation matches implemented commands and status behavior, verified by reviewing `extensions/pi-goal/README.md`.
- [x] Package verification passes with `npm run check` and `just pack-goal`.
