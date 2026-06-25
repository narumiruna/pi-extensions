## Goal

Fix issue #115's minimal verified failures in `@narumitw/pi-goal`: contradictory `goal_complete` calls must not clear active goals, paused/cleared goals must stop queued goal work as far as the extension can control, and retryable provider interruptions must not make goal status lie as `paused` while Pi is already retrying.

## Context

The downloaded issue logs in `data/*.html` show three concrete failures:

- `goal_complete` was accepted even when the tool summary said the goal was not completed.
- WebSocket/provider errors changed the goal state to `paused`, then the same goal work continued with tool calls seconds later.
- Goal continuation produced many short incomplete turns; that loop is expected only while the goal remains active, but it becomes confusing when stale turns survive pause/error handling.

## Architecture

Keep queue ownership in Pi core. `pi-goal` should only own a small goal-state guard:

- active goal state and continuation marker tracking
- completion-tool validation
- pause/clear abort requests
- stale goal-turn tool blocking after a goal is paused or cleared
- retryable-error classification only where needed to avoid false `paused` state

## Non-Goals

- Do not build a general message queue manager in `pi-goal`.
- Do not change `pi-retry` unless a narrow retry-classification bug is found during implementation.
- Do not attempt to prove arbitrary user-goal completion inside the extension; only block self-contradictory completion reports.

## Plan

- [x] Add regression tests in `extensions/pi-goal/test/goal.test.ts` for `goal_complete` summaries that contain clear incompletion language; verify the tool does not clear goal state, does not return `terminate: true`, and leaves status active with `npm test`.
- [x] Implement a small `isContradictoryCompletionSummary(summary)` guard in `extensions/pi-goal/src/goal.ts` that rejects direct contradictions like `not complete`, `still failing`, or `tests still fail`; verify the new regression test passes and normal positive summaries still terminate.
- [x] Add tests for `/goal pause` and `/goal clear` while a goal is active; verify `ctx.abort()` is called once, continuation markers are cancelled, and status becomes `paused` or undefined with `npm test`.
- [x] Call `ctx.abort()` from `pauseGoal`, `clearGoal`, and non-retryable `pauseGoalAfterAgentEnd`; verify the abort-count tests pass and no existing command tests regress.
- [x] Add a focused retryable-interruption classifier for provider errors that Pi is likely retrying (`WebSocket closed`, SSE/header timeout, context-window overflow with compaction/retry hints, or existing `provider returned error` retry hints); verify with unit tests that usage-limit/auth-limit messages remain non-retryable.
- [x] In `agent_end`, keep retryable interruptions active without sending a new goal continuation prompt, and only pause on user aborts or non-retryable errors; verify with tests that retryable errors do not append `goal-state: paused` and non-retryable errors still do.
- [x] Add a stale-goal tool-call guard: after pause/clear/non-retryable error, block tool calls from the cancelled goal turn until a new non-goal user prompt or `/goal resume` clears the guard; verify with a test that stale `tool_call` returns `{ block: true }` while a fresh user prompt is not blocked.
- [x] Update `extensions/pi-goal/README.md` to describe the guarded completion behavior, abort-on-pause/clear behavior, and retryable interruption behavior; verify package docs still match `pi-goal` commands.
- [x] Run `npm --workspace @narumitw/pi-goal run typecheck` and `npm test`; fix only failures caused by this change.

## Risks

- Summary-text validation can false-positive on legitimate completions that mention earlier incomplete states; keep the phrase list narrow and document that this is only a state-safety guard, not a completion verifier.
- Retryable-error classification can leave a goal active without Pi actually retrying; keep the classifier conservative and prefer existing retry hints when available.
- Tool-call blocking can block legitimate user work if not reset on fresh non-goal prompts; include reset tests.

## Completion Checklist

- [x] Contradictory `goal_complete` no longer clears active goals, verified by `npm test` regression coverage.
- [x] `/goal pause`, `/goal clear`, and non-retryable error pause request abort and cancel stale continuations, verified by `npm test`.
- [x] Retryable provider interruptions do not mark active goals as paused or enqueue duplicate goal continuations, verified by `npm test`.
- [x] Stale tool calls after a cancelled goal turn are blocked without blocking fresh user prompts, verified by `npm test`.
- [x] `extensions/pi-goal/README.md` documents the corrected behavior, verified by review of the README diff.
- [x] `@narumitw/pi-goal` typechecks, verified by `npm --workspace @narumitw/pi-goal run typecheck`.
