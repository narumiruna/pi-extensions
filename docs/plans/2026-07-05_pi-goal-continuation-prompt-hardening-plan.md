## Goal

Harden `pi-goal` continuation and goal-mode prompts with Codex-style objective fidelity, evidence-based completion audit, and blocked-audit guidance.

Success means an active goal is less likely to be narrowed, prematurely marked complete, or abandoned at a plan/TODO; tests prove the prompt contains the required guardrails without breaking continuation markers or objective escaping.

## Context

`extensions/pi-goal/src/goal.ts` currently builds compact prompts in `goalPersistenceRules()`, `buildGoalSystemPrompt()`, and `buildContinuePrompt()`. Codex's `third_party/codex/codex-rs/ext/goal/templates/goals/continuation.md` is stronger: it treats the objective as user-provided data, preserves full scope, requires requirement-by-requirement evidence, and defines strict blocked behavior.

## Architecture

Keep prompt construction in `extensions/pi-goal/src/goal.ts` unless the file becomes unwieldy. Prefer small helper functions or constants for reusable prompt sections:

- objective trust boundary;
- work-from-evidence rule;
- fidelity/no-scope-shrinking rule;
- completion audit rule;
- blocked audit rule if `blocked` status/tool is implemented first.

This plan can land before or after stopped statuses. If stopped statuses are not implemented yet, include blocked-audit wording as future-facing guidance only where it does not reference unavailable tools.

## Non-Goals

- Do not copy Codex templates verbatim if shorter Pi-specific wording is clearer.
- Do not change `/goal` command semantics in this slice.
- Do not add new status states unless executing the stopped-statuses plan at the same time.

## Plan

- [ ] Add failing prompt tests in `extensions/pi-goal/test/goal.test.ts` that assert continuation/system prompts include objective trust-boundary language, no-scope-shrinking language, evidence-based completion audit language, and current authoritative-state language; verify initial failures with `npm test`.
- [ ] Refactor prompt builders in `extensions/pi-goal/src/goal.ts` into concise reusable sections without changing public command behavior; verify existing parser/status tests still pass with `npm test`.
- [ ] Update `buildContinuePrompt()` to include Codex-style guidance that the full objective persists across turns, completion must be proven requirement by requirement, and weak/indirect evidence is not enough; verify prompt tests assert these phrases and the continuation marker remains parseable.
- [ ] Update `buildGoalSystemPrompt()`, `buildGoalPrompt()`, `buildResumePrompt()`, and `buildObjectiveUpdatedPrompt()` so first turn, resumed turn, edited objective turn, and automatic continuation share the same completion standard; verify tests cover each builder.
- [ ] If the stopped-statuses plan is already implemented, add blocked-audit prompt language that references the chosen blocked tool/status and the three-turn repeated-blocker threshold; otherwise add a TODO-free neutral warning not to stop merely because work is hard or uncertain; verify tests match the implemented branch.
- [ ] Update `extensions/pi-goal/README.md` completion/interruption sections to describe the stronger audit behavior and clarify that prompt wording is a guardrail, not a proof of completion; verify README examples remain concise.
- [ ] Run `npm run check` from the repository root and fix any formatting, type, or test failures.

## Risks

- Longer prompts consume more tokens and can make every goal turn more expensive.
- Overly broad prompt text may conflict with existing global/developer instructions unless it stays scoped to goal behavior.
- If blocked guidance references unavailable tools, the model may try to call tools that do not exist.

## Completion Checklist

- [ ] Continuation prompts preserve full-objective fidelity and evidence-based completion audit language, verified by prompt tests in `extensions/pi-goal/test/goal.test.ts`.
- [ ] First-turn, resume, edit, and system prompt builders share the hardened completion standard, verified by tests for each builder.
- [ ] Continuation marker cancellation/delivery still works with the longer prompt, verified by existing continuation-marker tests.
- [ ] Objective XML escaping remains correct for adversarial objective text, verified by prompt escaping tests.
- [ ] README documents the hardened completion behavior, verified by review of `extensions/pi-goal/README.md`.
- [ ] Repository verification passes with `npm run check`.
