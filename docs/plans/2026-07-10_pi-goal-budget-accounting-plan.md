## Goal

Make `pi-goal` token and elapsed-time accounting accurate enough to enforce user budgets and explain exhaustion. Success means the extension uses a documented total-token definition, excludes paused wall-clock time, detects exhaustion at the earliest reliable lifecycle boundary, and gives the model one bounded wrap-up instruction without declaring completion.

## Context

`currentTokenTotal()` currently sums only assistant `input` and `output`, although Pi usage also exposes `cacheRead`, `cacheWrite`, and `totalTokens`. Elapsed time is currently `Date.now() - startedAt`, so paused time is counted. Budget status is checked only in `agent_end`, while current Codex accounts at tool and turn boundaries and injects a budget-limit wrap-up item.

This plan depends on the idle-continuation plan so exhaustion can cancel continuation intent safely. It should land before prompt hardening.

## Architecture

Define one compatibility helper for cumulative assistant token usage:

1. use finite, non-negative `usage.totalTokens` when present;
2. otherwise use the Pi-compatible fallback established by local usage typings/tests;
3. never double-count cache fields already included in `totalTokens`.

Change elapsed time from wall-clock-since-creation to an accumulated active duration with a persisted active-start timestamp. Settle active duration whenever the goal stops, pauses, is edited into a stopped state, completes, or shuts down; restart the clock only when it becomes active.

At the earliest public Pi hook where assistant usage is persisted, transition once to `budget_limited`, cancel continuation intent, and inject one model-visible but non-user-authored wrap-up message when a turn is still running. Retain `agent_end` as the final fallback check.

## Unknowns

- Whether `tool_execution_end` always sees the current assistant usage persisted in `ctx.sessionManager` for every supported provider. Resolve with a focused lifecycle probe before choosing `tool_execution_end`, `tool_result`, or an agent-level fallback as the primary boundary.
- Whether `cacheWrite` is included in Pi's `totalTokens` fallback semantics. Resolve from the installed `@earendil-works/pi-ai` type/docs and encode the decision in tests and README wording.

## Plan

- [ ] Inspect the installed Pi usage type and lifecycle ordering to define total-token and tool-boundary semantics; record the chosen formula and hook in comments/tests, and verify with source references plus a mock lifecycle probe.
- [ ] Add failing tests for `totalTokens`, missing-`totalTokens` fallback, cached-token-heavy usage, malformed/negative usage, branch changes, and baseline subtraction; verify failures with `npm test` before implementation.
- [ ] Replace `currentTokenTotal()` with a typed cumulative usage helper that follows the documented formula and clamps invalid deltas; verify all accounting cases with focused tests.
- [ ] Extend persisted goal state with backward-compatible active-time fields, migrate older session entries during normalization, and settle/restart active duration on every status transition; verify tests for pause waiting, resume, edit, completion, reload, and legacy entries using a fake clock.
- [ ] Add the earliest reliable budget check after completed tool activity while retaining an `agent_end` fallback; verify a multi-tool turn reaches `budget_limited` once and cannot schedule another continuation.
- [ ] Add a single-flight budget wrap-up message that tells the model to stop substantive work, summarize progress/blockers, and not call `goal_complete` unless evidence already proves completion; verify only one message is injected across parallel tools and repeated lifecycle events.
- [ ] Ensure increasing the budget through `/goal edit --tokens ...` can reactivate only according to the stopped-status transition rules, while an unchanged exhausted budget remains `budget_limited`; verify command and stale-goal-ID tests.
- [ ] Update status and README wording to define counted tokens, active elapsed time, possible one-turn overshoot, and budget-limit wrap-up semantics; verify examples match formatter tests.
- [ ] Run `npm run check`; verify formatting, boundary checks, typechecks, and all tests pass.

## Risks

- Changing token semantics can exhaust existing budgets sooner after reload.
- Provider usage fields may not be uniform; an incorrect fallback could double-count cached tokens.
- Parallel tools can race to emit duplicate wrap-up messages without a goal-ID-scoped single-flight guard.
- Persisted-state evolution must remain readable by the current release during rollback.

## Rollback / Recovery

Keep old persisted fields readable and make new fields optional during normalization. If tool-boundary usage is not reliable on a supported provider, retain corrected token totals and active-time accounting while falling back to the final `agent_end` budget check.

## Completion Checklist

- [ ] Total-token semantics are documented and verified by direct, fallback, cached, invalid, and baseline accounting tests.
- [ ] Paused time is excluded and legacy goal entries remain readable, verified by fake-clock and migration tests.
- [ ] Budget exhaustion transitions once at the earliest reliable boundary and cancels continuation, verified by parallel-tool and turn-end tests.
- [ ] The model receives at most one non-completion wrap-up instruction, verified by repeated-event tests.
- [ ] Resume/edit behavior for exhausted budgets is verified by command and stale-ID tests.
- [ ] Documentation and repository checks are verified by README review and a passing `npm run check`.
