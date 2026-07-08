## Goal

Add a stale-completion guard to `@narumitw/pi-goal` so `goal_complete` can only complete the exact active goal instance that was presented to the current turn.

Success means an old, delayed, or replaced turn cannot mark a newer goal complete, while the current `/goal` completion flow and completion summary UX continue to work.

## Context

`extensions/pi-goal/src/goal.ts` currently stores an `ActiveGoal.id` and uses nonce-bearing continuation markers, but `goal_complete` only accepts `summary`. If a stale turn survives goal replacement or resume/clear races, the tool has no expected goal identifier to validate before mutating `activeGoal`.

Codex avoids this class of bug in its state layer with expected-goal-id guarded updates in `third_party/codex/codex-rs/state/src/runtime/goals.rs`.

## Architecture

Keep the Pi extension self-contained. Add a required `goal_id` parameter to `goal_complete`, inject the current goal id into goal-mode prompts, and reject tool calls whose `goal_id` does not match the current `activeGoal.id`.

The `summary` parameter remains for user-visible completion evidence; it is not used as a safety guard.

## Non-Goals

- Do not replace `goal_complete` with Codex-style `update_goal` in this slice.
- Do not remove the current summary/evidence requirement.
- Do not change goal persistence storage beyond storing any new compatibility metadata required by tests.

## Plan

- [x] Add focused failing tests in `extensions/pi-goal/test/goal.test.ts` for stale completion rejection after goal replacement, pause/resume, and clear; verify the tests fail before implementation with `npm test` from the repository root.
- [x] Extend the `goal_complete` tool schema in `extensions/pi-goal/src/goal.ts` with required `goal_id` and validate it before summary validation or state mutation; verify stale calls return a warning result and leave `lastGoalStatus(mock)` unchanged with `npm test`.
- [x] Inject the active goal id into `buildGoalSystemPrompt()`, `buildGoalPrompt()`, `buildResumePrompt()`, `buildObjectiveUpdatedPrompt()`, and `buildContinuePrompt()` as explicit completion-token guidance; verify prompt tests assert the goal id appears and XML escaping still passes with `npm test`.
- [x] Update continuation/stale-tool-call guards so rejected stale `goal_complete` calls do not clear continuation state or unblock paused/stopped stale tool calls; verify with existing pause/clear stale-call tests plus the new stale completion tests.
- [x] Update `extensions/pi-goal/README.md` completion documentation to explain that `goal_id` is a stale-turn guard and `summary` is completion evidence; verify README command/tool examples match the TypeScript tool schema by inspection.
- [x] Run `npm run check` from the repository root and fix any formatting, type, or test failures.

## Risks

- Models may omit the new required `goal_id` until prompts are clear enough, causing false rejections.
- Exposing raw goal ids in prompts can be confused with user objective data unless the prompt states that it is only a tool guard.
- Existing sessions with active goals created before this change will need the prompt injection path to supply the id from persisted `ActiveGoal.id`.

## Completion Checklist

- [x] `goal_complete` requires and validates `goal_id`, verified by `extensions/pi-goal/src/goal.ts` schema and execution checks.
- [x] Stale completion after replacement, pause/resume, or clear is rejected without completing the current goal, verified by targeted tests in `extensions/pi-goal/test/goal.test.ts`.
- [x] Current-goal completion still succeeds with matching `goal_id` and non-empty non-contradictory summary, verified by updated success tests.
- [x] Goal prompts consistently tell the model which `goal_id` to pass to `goal_complete`, verified by prompt snapshot/assertion tests.
- [x] Repository verification passes with `npm run check`.
