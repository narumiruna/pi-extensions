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

## Resolved unknowns

- Pi emits extension `message_end` handlers before AgentSession persists the assistant message. Unit coverage and the real `AgentSession` faux-provider smoke prove `tool_execution_end` sees that persisted usage, so it is the primary in-turn boundary; `agent_end` remains the no-tool fallback.
- Installed Pi provider implementations define `totalTokens` with cache usage included. The compatibility fallback is finite, non-negative `input + output + cacheRead + cacheWrite`; reasoning and one-hour cache-write values are subsets and are not added again.

## Plan

- [x] Inspected installed Pi usage types/provider implementations and lifecycle ordering; recorded the chosen formula and `tool_execution_end` boundary in comments, tests, README, runtime smoke, and repository memory.
- [x] Added tests for `totalTokens`, cache-inclusive fallback, cached-token-heavy usage, malformed/negative usage, branch changes, and baseline subtraction; verified they failed before implementation.
- [x] Replaced `currentTokenTotal()` with typed cumulative usage helpers that follow the documented formula and clamp invalid values/deltas.
- [x] Extended persisted goal state with a backward-compatible active-start field, normalized older and malformed budget entries, and settled/restarted active duration on transitions; verified pause waiting, resume, edit, completion, shutdown/reload, and legacy entries with fake clocks.
- [x] Added budget checks after completed tool activity, at reload/compaction retry boundaries, and at `agent_end`; verified multi-tool, no-tool, retry, compaction, reload, and continuation-cancellation behavior.
- [x] Added a goal-scoped, single-flight custom wrap-up instruction, aborting substantive-tool blocks, bounded completion permission/rejection, stale-context filtering, and failed-delivery retry; verified one accepted message across repeated events.
- [x] Made `/goal edit --tokens ...` reactivate a budget-limited goal only when the new budget exceeds current usage while preserving other stopped statuses; verified stale-goal-ID rotation and rollback when prompt delivery fails.
- [x] Updated status and README wording to define counted tokens, active elapsed time, one-call overshoot, and budget-limit wrap-up semantics.
- [x] Ran `npm run check` with 239 passing tests, the seven-scenario real-AgentSession runtime smoke, checks against Pi 0.79.10 and 0.80.3, and `just pack-goal`; the package dry run contains only `LICENSE`, `README.md`, `package.json`, and `src/goal.ts`.

## Risks

- Changing token semantics can exhaust existing budgets sooner after reload.
- Provider usage fields may not be uniform; an incorrect fallback could double-count cached tokens.
- Parallel tools can race to emit duplicate wrap-up messages without a goal-ID-scoped single-flight guard.
- Persisted-state evolution must remain readable by the current release during rollback.

## Rollback / Recovery

Keep old persisted fields readable and make new fields optional during normalization. If tool-boundary usage is not reliable on a supported provider, retain corrected token totals and active-time accounting while falling back to the final `agent_end` budget check.

## Completion Checklist

- [x] Total-token semantics are documented and verified by direct, fallback, cached, invalid, and baseline accounting tests.
- [x] Paused time is excluded and legacy goal entries remain readable, verified by fake-clock and migration tests.
- [x] Budget exhaustion transitions once at the earliest reliable boundary and cancels continuation, verified by parallel-tool, compaction, retry, and turn-end tests.
- [x] The model receives at most one non-completion wrap-up instruction, verified by repeated-event, invalid-completion, tool-violation, and failed-delivery tests.
- [x] Resume/edit behavior for exhausted budgets is verified by command and stale-ID tests.
- [x] Documentation, Pi compatibility, runtime, repository, and packaging checks are verified by README review and the passing commands recorded above.
