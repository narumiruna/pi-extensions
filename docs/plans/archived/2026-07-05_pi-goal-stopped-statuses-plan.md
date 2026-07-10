## Goal

Add Codex-inspired stopped statuses to `@narumitw/pi-goal`: `blocked` for true impasses and `usage_limited` for provider/account quota limits.

Success means users can distinguish intentional pause, model-reported blocker, usage-limit stop, budget-limit stop, and completion; `/goal resume` can restart resumable stopped states safely.

## Context

`pi-goal` previously had `active`, `paused`, `budget_limited`, and `complete`. Non-retryable aborted/error turns were generally paused, and there was no model-facing way to stop an active goal as blocked. Codex uses distinct blocked and usage-limited states and requires repeated blocker evidence before a model can mark a goal blocked.

## Architecture

The implementation extends the local session-entry state machine without adding Codex's SQLite store:

- `paused`: user-initiated pause or aborted/interrupted assistant turn.
- `blocked`: an accepted `goal_blocked` report or a terminal non-usage agent error.
- `usage_limited`: a terminal provider/account subscription, quota, credit, or billing-limit error; transient rate limits remain retryable.
- `budget_limited`: the user-configured goal token budget is exhausted.
- `complete`: the goal is achieved and verified.

A dedicated `goal_blocked({ goal_id, reason, evidence, repeated_turns })` tool keeps `goal_complete` backward-compatible and limits the model-facing API to the smallest required status transition. Its schema and execution path require the current active goal, non-empty reason/evidence, a whole `repeated_turns` value of at least three, and a fresh three-turn audit after resume.

## Non-Goals

- Exact Codex SDK logical goal streams and SQLite persistence were not added.
- `blocked` is not a substitute for ordinary clarification, uncertainty, incomplete work, or recoverable failures.

## Resolved Unknowns

- Chose the dedicated `goal_blocked` tool instead of a broad `goal_update` API. This preserves the existing completion contract and prevents model-driven pause, resume, usage-limit, or budget-limit transitions.
- Statusline output uses compact plain values: `blocked` and `usage`.

## Plan

- [x] Added failing tests in `extensions/pi-goal/test/goal.test.ts` for stopped formatting, persistence, resume acceptance/rejection, stale tool blocking, and usage-limit classification. The initial run failed on the missing classification export; an adjacent credit-balance case was also proven red before its regex fix.
- [x] Extended `GoalStatus`, session persistence validation, `formatStatus()`, `goalSummary()`, and command hints for `blocked` and `usage_limited`; persistence and formatter tests pass.
- [x] Updated `/goal resume` for paused, blocked, usage-limited, and eligible budget-limited goals while preserving active-only `/goal pause`; tests cover all accepted statuses, active rejection, exhausted-budget rejection without mutation, and prompt-delivery rollback to the original stopped state/id/guard.
- [x] Added strict `goal_blocked({ goal_id, reason, evidence, repeated_turns })` handling with current-id and active-state guards, bounded non-empty reason/evidence, a whole three-turn minimum, stopped-state persistence, stale-tool blocking, and terminating results; tool schema and execution tests pass.
- [x] Split interruption classification so aborts become `paused`, terminal usage/quota/credit/billing limits become `usage_limited`, transient rate/server failures remain retryable through a Pi-compatible classifier, and other terminal errors become `blocked`; retry and context-overflow tests pass.
- [x] Generalized stale tool-call blocking to in-flight `paused`, `blocked`, and `usage_limited` transitions until fresh user input, resume, or clear; parameterized tests verify extension input does not release the guard and resume does.
- [x] Updated `extensions/pi-goal/README.md` with all states, compact statusline values, resume/edit semantics, strict blocker requirements, and interruption classification.
- [x] Ran `npm run check`; Biome, extension boundaries, all workspace typechecks, and 221 tests passed.

## Risks

- The model self-reports that the same blocker recurred across three consecutive turns because Pi does not expose blocker identity. The strict schema, evidence requirement, and prompt guidance mitigate overuse without claiming runtime proof that Pi cannot provide.
- Provider limit wording varies. The classifier recognizes explicit subscription/quota/credit/billing exhaustion as `usage_limited` while routing transient rate, 429, and server failures through a compatibility mirror of Pi's retry semantics (Pi 0.79 does not export the newer helper).
- Statusline consumers now receive `blocked` and `usage`; `pi-statusline` already accepts arbitrary plain status text.

## Rollback / Recovery

Persisted entries remain backward-compatible because the existing fields are unchanged and only two status literals were added. Reverting the source, tests, and README together returns to the previous state machine; sessions stored with a new status would need resume/clear before loading under an older release.

## Completion Checklist

- [x] `pi-goal` state supports `blocked` and `usage_limited`, verified by workspace typechecks plus persistence and formatter tests.
- [x] Users can resume paused, blocked, usage-limited, and eligible budget-limited goals, verified by accepted/rejected command tests and stale-id rotation assertions.
- [x] The model can mark only a current active goal blocked with matching goal id, bounded non-empty reason/evidence, and at least three whole repeated turns, verified by tool schema and execution tests.
- [x] Usage-limit interruptions produce `usage_limited` instead of generic `paused`, verified across subscription, usage, quota, credit, and billing fixtures; rate, 429, and server fixtures remain retryable.
- [x] Retryable provider/context-overflow interruptions remain active, verified by the existing retry, Codex hint, and compaction tests.
- [x] README and statusline examples document all stopped statuses, verified by review and matching formatter assertions.
- [x] Repository verification passes with `npm run check`; runtime continuation smoke and `just pack-goal` also pass, and the dry-run tarball contains only `LICENSE`, `README.md`, `package.json`, and `src/goal.ts`.
