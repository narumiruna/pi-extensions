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

- [x] Added failing prompt tests asserting a trust boundary before objective data, no-scope-shrinking, evidence-based completion audit, current authoritative-state, and blocked-audit language; verified the initial failures with focused `npm test` runs.
- [x] Refactored prompt builders around one concise `goalModeRules()` section without changing public command behavior; existing parser, status, lifecycle, and runtime tests still pass.
- [x] Updated `buildContinuePrompt()` so the full objective persists across turns, completion is proven requirement by requirement, and weak/indirect evidence is insufficient; tests verify the guidance and parseable nonce marker.
- [x] Updated system, kickoff, resume, edited-objective, and continuation builders to share the same completion standard; one lifecycle test exercises every path.
- [x] Added `goal_blocked` audit language for true impasses, concrete evidence, three consecutive goal turns, fresh resumed audits, and rejection of hard/slow/uncertain/recoverable cases; tests match the implemented tool contract.
- [x] Updated README completion, blocked, feature, and budget sections to describe the shared audit and clarify that prompt wording is a behavioral guardrail rather than proof.
- [x] Ran `npm run check` with 240 passing tests, the seven-scenario real-AgentSession runtime smoke, `just pack-goal`, and `git diff --check`; all passed and the package contains only the four intended files.

## Risks

- Longer prompts consume more tokens and can make every goal turn more expensive.
- Overly broad prompt text may conflict with existing global/developer instructions unless it stays scoped to goal behavior.
- If blocked guidance references unavailable tools, the model may try to call tools that do not exist.

## Completion Checklist

- [x] Continuation prompts preserve full-objective fidelity and evidence-based completion audit language, verified by prompt tests in `extensions/pi-goal/test/goal.test.ts`.
- [x] First-turn, resume, edit, and system prompt builders share the hardened completion standard, verified by tests for each builder.
- [x] Continuation marker cancellation/delivery still works with the longer prompt, verified by marker and continuation lifecycle tests.
- [x] Objective XML escaping remains correct for adversarial objective text in kickoff, system, and continuation paths, verified by prompt escaping tests.
- [x] README documents the hardened completion behavior and its proof limitations, verified by review of `extensions/pi-goal/README.md`.
- [x] Repository verification passes with `npm run check` (240 tests), runtime smoke, and package preview.
