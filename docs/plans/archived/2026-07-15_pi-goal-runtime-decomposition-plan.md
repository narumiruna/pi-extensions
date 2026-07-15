## Goal

Decompose `extensions/pi-goal/src/goal.ts` along clear responsibility boundaries so each source module stays below 1,000 lines without changing the extension's commands, tools, persistence, queue semantics, or lifecycle behavior.

## Context

`goal.ts` is 2,174 lines after the ordered-queue merge. Review found three cohesive responsibilities that can be separated without splitting race-sensitive event ordering mechanically: Pi registration/lifecycle orchestration, reusable per-session runtime infrastructure, and user-command state transitions.

## Architecture

- Keep `goal.ts` as the composition root that registers tools, `/goal`, and Pi lifecycle handlers in their current order.
- Move per-factory mutable state plus shared prompt ownership, continuation, budget, persistence, status, and tool-visibility mechanisms to `runtime.ts`.
- Move `/goal` mutation flows, including ordered-queue transitions and delivery rollback, to `commands.ts` as a controller over one `GoalRuntime` instance.
- Preserve existing helper exports from `goal.ts` as compatibility re-exports while allowing focused modules to be tested directly later.

## Non-Goals

- Do not change public commands, tool schemas, settings, persisted state, notifications, or runtime timing.
- Do not introduce dependencies or mechanically create one-file-per-function modules.

## Plan

- [x] Record the current pi-goal test baseline and source line counts; `npm test` passed 476 tests and `wc -l` recorded `goal.ts` at 2,174 lines before decomposition.
- [x] Extract shared per-session state and invariant-preserving helpers into `extensions/pi-goal/src/runtime.ts`; pi-goal typecheck and the complete 476-test suite pass with one runtime instance per factory.
- [x] Extract user command and queue mutation flows into `extensions/pi-goal/src/commands.ts`; the command, queue, reload, rollback, stale-id, tool-policy, compaction, and factory-isolation regressions pass through root `npm test`.
- [x] Reduce `goal.ts` to Pi tool/command/event orchestration and preserve compatibility re-exports; `wc -l extensions/pi-goal/src/*.ts` reports 858 lines for `goal.ts`, 823 for `runtime.ts`, 578 for `commands.ts`, and every pi-goal source file below 1,000 lines.
- [x] Run formatting, explicit ignored-source Biome checks, full repository checks, runtime smoke, package dry run, and `git diff --check`; final verification passed 476 tests, all 16 workspace typechecks, the real Pi smoke, and a 12-file tarball.
- [x] Archive this plan after every completion check passes; archived at `docs/plans/archived/2026-07-15_pi-goal-runtime-decomposition-plan.md`.

## Risks

- Moving closure helpers can accidentally share state across extension factories; mitigate by constructing one `GoalRuntime` and one command controller per extension factory.
- Prompt delivery and settled-boundary queue transitions are race-sensitive; retain event ordering in `goal.ts` and verify existing compaction, reload, queue, child-runtime, and stale-prompt regressions.

## Completion Checklist

- [x] `goal.ts`, `runtime.ts`, and `commands.ts` have clear documented responsibilities and each pi-goal source file is below 1,000 lines; module comments document composition-root, per-factory runtime, and command-controller ownership, and `wc -l` reports a maximum of 858 lines.
- [x] Public `/goal`, `goal_complete`, `goal_blocked`, queue, persistence, tool visibility, and lifecycle behavior is unchanged; `npm run check` passed 476 tests and the pi-goal runtime smoke passed normal, queue, pause, budget, and compaction scenarios.
- [x] The published package includes the new source modules and no unintended files; `just pack-goal` produced the expected 12-file tarball containing `commands.ts` and `runtime.ts`.
- [x] The final diff is formatting-clean and limited to the decomposition plus its archived plan; explicit ignored-source Biome checks and `git diff HEAD --check` passed.
