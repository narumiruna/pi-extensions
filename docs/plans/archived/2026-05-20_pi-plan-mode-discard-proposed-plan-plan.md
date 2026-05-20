## Goal

Fix `pi-plan-mode` so exiting Plan mode means discarding the currently proposed plan, preventing an unwanted `<proposed_plan>` from being reintroduced into later non-plan conversation turns. Success means explicit implementation still carries the plan forward, but plain exit/off does not.

## Context

Current behavior in `extensions/pi-plan-mode/src/plan-mode.ts` stores detected plans in `state.latestPlan` and emits a visible `customType: "proposed-plan"` message. `exitPlanMode()` disables Plan mode but leaves `latestPlan` in state, and the non-plan `context` filter only removes `plan-mode-context`, so stale proposed-plan artifacts can remain available to the model after the user exits without choosing implementation.

## Non-Goals

- Do not change the `<proposed_plan>` XML contract or Plan-mode prompt shape.
- Do not remove the explicit `Implement this plan` flow; that path should still pass the selected plan into the implementation turn.
- Do not add a broader session-pruning feature beyond Plan-mode artifacts needed for this bug.

## Assumptions

- `/plan exit`, `/plan off`, and the menu option `Exit Plan mode` should all mean “discard this proposed plan.”
- The visible `proposed-plan` message is useful while Plan mode is active, but should not participate in non-plan context after discard.

## Plan

- [x] Add a small state transition helper in `extensions/pi-plan-mode/src/plan-mode.ts` that exits Plan mode and clears `latestPlan`/`awaitingAction` by default; verified by code inspection of `exitPlanMode()` and all `/plan exit`, `/plan off`, and menu exit call paths.
- [x] Preserve the implementation behavior by capturing `state.latestPlan` before discard and sending only the `plan-mode-implementation` message in `startImplementation()`; verified by code inspection and `npm --workspace @narumitw/pi-plan-mode run typecheck`.
- [x] Extend the non-plan `context` filter to remove Plan-mode artifacts that should not leak after exit, including `plan-mode-context` and visible `proposed-plan` custom messages; verified by code inspection of `messageContainsInactivePlanModeArtifact()` and successful root `npm run check`.
- [x] Decide whether assistant messages containing raw `<proposed_plan>...</proposed_plan>` need scrubbing in addition to removing extension custom messages; implemented bounded scrubbing of exact proposed-plan XML blocks in assistant text content and verified by code inspection of `stripProposedPlanBlocksFromMessage()` plus successful root `npm run check`.
- [x] Update `extensions/pi-plan-mode/README.md` to document that exiting discards the proposed plan while choosing implementation carries it forward; verified by README review.
- [x] Run `npm --workspace @narumitw/pi-plan-mode run typecheck` to verify the package compiles; command passed.
- [x] Run `npm run check` from the repository root to verify formatting, linting, and workspace typechecks; command passed.

## Risks

- Over-filtering could remove useful historical planning context from ordinary resumed sessions; mitigated by filtering only Plan-mode custom artifacts and scrubbing only exact `<proposed_plan>` blocks from assistant text.
- Clearing `latestPlan` too early could break the implementation path; mitigated by capturing the plan before calling `exitPlanMode()` in `startImplementation()`.

## Completion Checklist

- [x] Plain Plan-mode exit discards `state.latestPlan` and `awaitingAction`, verified by code inspection of all exit/off call paths in `extensions/pi-plan-mode/src/plan-mode.ts`.
- [x] `Implement this plan` still starts a normal implementation turn with the selected plan text, verified by code inspection of `startImplementation()` and successful `npm --workspace @narumitw/pi-plan-mode run typecheck`.
- [x] Non-plan context no longer includes stale Plan-mode proposed-plan artifacts after discard, verified by predicate/scrubber code review and successful `npm run check`.
- [x] User-facing docs describe discard-vs-implement behavior, verified in `extensions/pi-plan-mode/README.md`.
- [x] Repository verification passes with `npm --workspace @narumitw/pi-plan-mode run typecheck` and `npm run check`.
