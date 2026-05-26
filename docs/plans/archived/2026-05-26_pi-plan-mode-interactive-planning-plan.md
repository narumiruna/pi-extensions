## Goal

Make `@narumitw/pi-plan-mode` behave more like Codex Plan Mode by encouraging real interactive planning before a `<proposed_plan>` is emitted. Success means Plan mode explores first, asks user-facing decision questions when high-impact ambiguity remains, only finalizes a plan when decision-complete, and keeps Plan-mode instructions scoped to active Plan-mode turns.

## Context

Current `extensions/pi-plan-mode/src/plan-mode.ts` injects a short hidden custom message from `buildPlanModePrompt()`, detects any assistant `<proposed_plan>` block in `agent_end`, and immediately opens the ready menu. Codex's third-party implementation uses a stronger prompt in `third_party/codex/codex-rs/collaboration-mode-templates/templates/plan.md` plus a dedicated `request_user_input` tool contract in `third_party/codex/codex-rs/core/src/tools/handlers/request_user_input_spec.rs` for decision questions. Codex keeps the implementation popup as the finalization path, not the clarification path.

## Architecture

- Prompt scoping should move from a persistent custom message to a per-turn `systemPrompt` append in `before_agent_start`, guarded by `state.enabled`, so Plan-mode rules disappear automatically when Plan mode is off.
- Legacy `plan-mode-context` custom messages should be filtered from LLM context even when Plan mode remains active, because the new system-prompt path replaces them; visible `proposed-plan` artifacts should still be filtered when leaving Plan mode or otherwise inactive.
- Following Codex's `request_user_input` design, `pi-plan-mode` should register a dedicated `plan_mode_question` tool with a dependency-free schema: `questions` contains 1-3 questions, each with `id`, `header`, `question`, and 2-4 meaningful `{ label, description }` options. The tool should add a free-form Other path in the UI, return structured answers to the model, and reject calls when Plan mode is not active.
- `plan_mode_question` should be a required Plan-mode tool: available by default while Plan mode is active, hidden or inactive after Plan mode exit, and not user-disableable through `/plan tools`.
- Proposed-plan detection and the ready menu should remain the finalization path, not the clarification path.

## Non-Goals

- Do not redesign Plan mode's user-selectable non-built-in tool risk model beyond pinning the required question tool.
- Do not change the `<proposed_plan>` XML contract used by plan detection.
- Do not implement a general Pi collaboration-mode framework outside this extension.

## Assumptions

- Pi's `before_agent_start` `systemPrompt` override is per-turn and safe to gate on `state.enabled`.
- A Codex-like question tool can be implemented with the current extension API and `ctx.ui` without adding package dependencies, using the local Pi `question` example as the UI pattern but not importing its `typebox` dependency.

## Unknowns

- Resolved: `plan_mode_question` uses `ctx.ui.select()` for option choice plus `ctx.ui.editor()` for the free-form Other path, based on the local `question.ts` pattern and verified by the smoke harness.

## Plan

- [x] Inspect Pi's `question.ts` and `questionnaire.ts` examples to choose the smallest UI primitive for `plan_mode_question`; verified by implementing `ctx.ui.select()` plus `ctx.ui.editor()` and by the smoke harness output `pi-plan-mode smoke passed: select+editor primitive, question result contract, prompt scoping, context filtering, ready menu implement/stay`.
- [x] Replace the hidden Plan-mode context message in `before_agent_start` with a `systemPrompt: event.systemPrompt + ...` append guarded by `state.enabled`, keeping `applyPlanModeTools()` and ready-state clearing intact; verify by code inspection that active Plan-mode turns no longer emit new `PLAN_CONTEXT_MESSAGE_TYPE` messages, legacy `plan-mode-context` custom messages are always filtered from model context even while Plan mode is active, visible `proposed-plan` artifacts are still filtered after Plan mode exit, and `npm --workspace @narumitw/pi-plan-mode run typecheck` passes.
- [x] Rewrite `buildPlanModePrompt()` using Codex's phases: explore first, intent chat, implementation chat, asking-question rules, finalization-only `<proposed_plan>`, and no "should I proceed?" in final output; verify with a side-by-side review against `third_party/codex/codex-rs/collaboration-mode-templates/templates/plan.md` and ensure the final prompt still references Pi's tool-safety boundaries, `plan_mode_question` as the preferred question path, and the required behavior for cancellation/no-UI results.
- [x] Register `plan_mode_question` in `extensions/pi-plan-mode/src/plan-mode.ts` with a dependency-free parameter schema for 1-3 questions, 2-4 meaningful options per question, a UI-added free-form Other path, structured answer details, cancellation output, and `ctx.hasUI` fallback; verify with typecheck and a local harness or smoke run that a selected answer is returned to the model without adding `typebox` or other runtime dependencies.
- [x] Define the `plan_mode_question` result contract so option/custom answers return `{ cancelled: false, answers: [...] }`, user cancellation returns `{ cancelled: true, reason: "cancelled" }`, no-UI returns `{ cancelled: true, reason: "ui_unavailable" }`, and outside-Plan calls return a clear unavailable error; verify with unit-style harness cases or manual smoke output for each path.
- [x] Enforce Plan-mode-only availability for `plan_mode_question` by rejecting handler calls when `state.enabled` is false, excluding it from restored non-plan active tools after exit/session start, and pinning it into the active tool list while Plan mode is enabled; verify by inspecting `activatePlanModeTools()`, `restoreTools()`, and session-start behavior.
- [x] Keep `plan_mode_question` required and non-disableable in `/plan tools` by excluding it from user-risk toggles or rendering it as fixed/on; verify by code inspection of the selector and a smoke check that user-selected non-built-in tools still persist independently.
- [x] Adjust proposed-plan readiness handling only as needed so clarification turns without `<proposed_plan>` do not open the ready menu, while completed plan turns still show `Implement this plan`, `Stay in Plan mode`, and `Exit Plan mode`; verify with code inspection of `agent_end` and a local scripted or manual smoke run for question-only response → `📝 plan active`.
- [x] Smoke test the finalization path `<proposed_plan>` → ready menu → `Implement this plan` starts a normal implementation turn, and `Stay in Plan mode` allows a revision turn before a replacement plan; verify with a local scripted or manual run and record the observed behavior in the handoff.
- [x] Update `extensions/pi-plan-mode/README.md` to describe the interactive workflow: explore, ask decision questions, finalize with `<proposed_plan>`, revise by staying in Plan mode, and implement only after approval; verify by README review plus `rg -n "ask|question|proposed_plan|Stay in Plan mode" extensions/pi-plan-mode/README.md`.
- [x] Run repository verification for the changed package with `npm --workspace @narumitw/pi-plan-mode run typecheck`, root `npm run check`, and `npm run pack:plan-mode`; verify all commands pass and the dry-run package does not rely on undeclared runtime dependencies.

## Risks

- A too-strong prompt could over-ask for simple tasks; mitigate by keeping Codex's rule that questions must materially affect the plan or confirm important assumptions.
- A question tool that waits incorrectly could deadlock or fail in non-interactive/RPC sessions; mitigate with an explicit `ctx.hasUI` result contract, cancellation output, and a smoke test.
- Registering `plan_mode_question` as a normal Pi tool could expose it outside Plan mode; mitigate by filtering active tools outside Plan mode and refusing handler execution when `state.enabled` is false.
- Importing schema helpers from an example-only dependency could break the published extension; mitigate with a dependency-free schema or, if that proves impossible, adding a real runtime dependency and verifying with `npm run pack:plan-mode`.
- Moving from custom message to `systemPrompt` could remove useful persisted reminders after resume; mitigate by re-appending on every active Plan-mode `before_agent_start`.

## Completion Checklist

- [x] Plan-mode instructions are scoped to active Plan-mode turns only, verified by code inspection of `before_agent_start`, absence of new active `plan-mode-context` custom message injection, and continued filtering of legacy Plan-mode context artifacts both inside and outside active Plan mode.
- [x] Plan-mode prompt matches the Codex interaction model, verified by review against `third_party/codex/codex-rs/collaboration-mode-templates/templates/plan.md` for exploration, question, and finalization rules.
- [x] The model has a structured Codex-like path to ask user decision questions before finalizing, verified by a smoke run or harness covering `plan_mode_question` option answer, custom answer, cancellation, no-UI fallback, and outside-Plan rejection.
- [x] `plan_mode_question` is Plan-mode-only and required while planning, verified by active-tool code inspection and a smoke/harness check that it is rejected or inactive outside Plan mode and cannot be disabled from `/plan tools`.
- [x] Existing finalization and implementation actions still work, verified by a smoke/harness run for `<proposed_plan>` → ready menu → implement and Stay/revision behavior plus a successful package typecheck.
- [x] User-facing documentation explains the new interactive behavior without exposing unnecessary implementation details, verified by README review.
- [x] Package and repository checks pass, verified by `npm --workspace @narumitw/pi-plan-mode run typecheck`, `npm run check`, and `npm run pack:plan-mode`.