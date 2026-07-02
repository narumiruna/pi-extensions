## Goal

Fix `@narumitw/pi-goal` so an active `/goal` survives Pi auto-compaction and provider retry paths without blocking the retry's tool calls. Success means issue #124's sequence no longer pauses the goal or enables stale-tool blocking, while real user pause and non-retryable errors still block stale tool calls.

## Context

Issue #124 is real, but the likely root cause is lifecycle ordering, not lost session state:

1. Pi emits `agent_end` to extensions.
2. `pi-goal` currently treats some context-overflow errors as non-retryable, pauses the goal, and enables stale tool-call blocking.
3. Pi core then performs auto-compaction / retry.
4. The retried assistant tool call is blocked by `pi-goal`.

Goal state is stored in session custom entries and is still present after compaction, so the fix should focus on retry classification, compaction-aware continuation handling, and stale-block scope.

## Architecture

- Keep `/goal` state session-owned via `goal-state` custom entries.
- Add a tiny in-memory recovery marker for Pi-owned recovery flows (`provider_retry` / `compaction_retry`) so `pi-goal` does not enqueue duplicate continuations while Pi core is retrying.
- Treat stale tool-call blocking as a pause/interruption guard only; compaction and retry flows are not stale work.

## Non-Goals

- Do not change Pi core compaction behavior.
- Do not change `goal_complete` acceptance rules beyond tests needed for this bug.
- Do not add a new persistence format unless the existing `goal-state` custom entry is proven insufficient.

## Plan

- [x] Sync local dependencies to the repo lockfile before editing so compaction event types match the target package; verified with `npm install` and `npm ls @earendil-works/pi-coding-agent --depth=0` resolving `0.79.8` without `invalid` output.
- [x] Update `extensions/pi-goal/src/goal.ts` retry classification to use Pi's context-overflow detector for assistant errors, falling back to the existing provider-retry regex for non-overflow transient failures; verified with unit cases where `prompt is too long...`, OpenRouter `maximum context length...`, and `context_length_exceeded` all keep the goal active.
- [x] Extend `findFinalAssistantMessage()` / `AssistantMessageLike` only as far as needed for overflow detection (`provider`, `model`, `usage`, `timestamp`, `content`, `api` if required by the imported type); verified with existing `findFinalAssistantMessage` tests plus one assistant message containing usage.
- [x] Add a small recovery marker in `extensions/pi-goal/src/goal.ts` so retryable `agent_end` clears pending goal continuation, persists active goal state, and returns without pause, abort, stale-block, or auto-continuation; verified with tests that retryable overflow and WebSocket errors keep `tool_call` unblocked and overflow does not call `abort()`.
- [x] Register `session_before_compact` and `session_compact` hooks for active goals: persist latest goal state before compaction, cancel any pending continuation marker, mark overflow+retry compaction as Pi-owned recovery, and avoid sending a duplicate continuation when `willRetry` is true; verified by simulating both hook events in `extensions/pi-goal/test/goal.test.ts`.
- [x] For manual/threshold compaction without Pi retry, enqueue at most one fresh goal continuation after compaction when the goal is still active and no messages are pending; verified the old pre-compaction continuation marker is consumed and only one post-compaction continuation can be sent.
- [x] Keep stale tool blocking limited to `/goal pause` and non-retryable `pauseGoalAfterAgentEnd()`; verified `/goal clear`, retryable provider errors, and compaction hooks leave `tool_call` unblocked.
- [x] Update `extensions/pi-goal/README.md` only for user-visible behavior: active goals survive Pi compaction/retry and stale tool blocking is reserved for pause/non-retryable interruption; verified the README does not claim goal state was previously lost.
- [x] Run focused verification with `npm test -- --package pi-goal` and `npm run typecheck`; verified both commands pass.
- [x] Run release/package verification with `npm run check` and `npm run pack:goal`; verified check passes and dry-run package contains only `LICENSE`, `README.md`, `package.json`, and `src/goal.ts`.

## Risks

- Mitigated: importing Pi overflow helpers required adding `@earendil-works/pi-ai` as a pi-goal dev dependency; verified with `npm run typecheck` plus `npm run pack:goal`.
- Mitigated: Pi `0.79.8` compaction hook typings lack `reason` / `willRetry`, so the implementation uses optional field checks and a goal recovery marker fallback; verified by focused compaction tests.
- Mitigated: duplicate continuation prevention is covered by a test that cancels a pre-compaction continuation, consumes its marker, and sends only one fresh continuation.

## Rollback / Recovery

- If the full recovery-state change misbehaves before release, revert the pi-goal source/test/README/package metadata changes and ship the smaller overflow-classification fix as a patch.
- If a published patch regresses goal mode, publish a follow-up patch; npm unpublish is not a practical rollback path for users.

## Completion Checklist

- [x] Issue #124 reproduction is covered by `overflow compaction retry keeps the goal active and does not block retry tools` in `extensions/pi-goal/test/goal.test.ts`.
- [x] Retryable provider errors keep active goal state and are verified by `agent_end keeps retryable interruptions active but pauses non-retryable errors` in `extensions/pi-goal/test/goal.test.ts`.
- [x] User pause and non-retryable errors still block stale tool calls and are verified by `pause aborts the current turn...`, `stale goal tool calls...`, and the non-retryable branch of the agent-end test.
- [x] Compaction hooks preserve active goal state and prevent duplicate continuations, verified by `overflow compaction retry...` and `manual compaction cancels stale continuation...` tests.
- [x] Package metadata remains installable and minimal, verified by `npm run typecheck`, `npm test -- --package pi-goal`, `npm run check`, and `npm run pack:goal`.
- [x] User-facing behavior is documented in `extensions/pi-goal/README.md` and verified by review of the changed Features and Interruption sections.
