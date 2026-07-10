## Goal

Move `pi-goal` automatic continuation from the fragile `agent_end` follow-up path to Pi's fully settled idle boundary. Success means an eligible active goal starts exactly one continuation after retries, compaction, and queued messages settle, while pause, clear, replacement, completion, pending work, and stale prompts cannot restart it.

## Context

`extensions/pi-goal/src/goal.ts` previously classified outcomes and sent the next prompt from `agent_end`. Pi `0.80.6` exposes `agent_settled` after retry, compaction, steering, and follow-up work has drained. Current Codex similarly waits for a thread-idle lifecycle and uses an atomic idle-turn gate.

Pi extensions cannot reproduce Codex's hidden context or core turn reservation, so this implementation uses the strongest safe behavior available through public Pi APIs and documents the remaining race.

## Architecture

The implemented responsibilities are split as follows:

- `agent_end`: records usage, classifies retryable/non-retryable outcomes, updates budget/state, and creates a plain in-memory continuation intent.
- `agent_settled`: re-reads the current goal and intent, requires `ctx.isIdle()`, rejects pending messages, and dispatches one immediate continuation.
- compaction hooks: cancel stale intent/delivery; Pi-owned retries defer to the retry, while non-retrying compaction creates one fresh intent.
- `session_compact`: uses the same single-flight dispatcher as a narrow fallback because manual compaction does not emit `agent_settled`.

Goal ID, iteration, and nonce form each continuation ticket. Intent and accepted delivery are tracked separately so repeated settled events are idempotent and newer work can cancel a delivery that lost Pi's non-atomic idle race.

## Resolved Unknowns

- Pi `0.80.6` emits `agent_settled` after complete agent runs, including queued follow-up work, but not after standalone manual compaction. Verified from the installed runtime and `npm run test:runtime --workspace @narumitw/pi-goal`; the implementation retains only the shared idle-gated `session_compact` fallback.
- Pi extensions still cannot atomically reserve an idle turn. If another extension wins after the idle check, its `before_agent_start` cancels both the old intent and accepted delivery, and its eventual `agent_end` creates a fresh continuation. This residual race is documented in the README.

## Plan

- [x] Added failing tests in `extensions/pi-goal/test/goal.test.ts` for intent-only `agent_end`, exactly-once `agent_settled`, and repeated settled events; the pre-implementation run failed six goal tests and the final focused run passed.
- [x] Added race tests for pending messages, retryable and non-retryable errors, overflow retry, manual compaction, pause, clear, replacement, completion, budget exhaustion, failed dispatch, and a delivery that loses the start race; verified by the passing goal tests in `npm test`.
- [x] Replaced `ContinuationPending` with separate single-flight intent and delivery tickets keyed by goal ID, iteration, and nonce; existing and new marker-cancellation tests pass.
- [x] Removed ordinary continuation sending from `agent_end`; source inspection with `rg -n 'agent_end|deliverAs: "followUp"|sendUserMessage' extensions/pi-goal/src/goal.ts` shows `agent_end` only records intent and the settled dispatcher sends the continuation without follow-up options.
- [x] Registered `agent_settled` with current-goal, active-status, idle, pending-message, and single-flight gates; focused tests cover each rejection and successful dispatch path.
- [x] Reworked compaction so Pi-owned retries create no continuation and non-retrying compaction creates at most one fresh ticket; unit and real-runtime manual-compaction checks pass.
- [x] Substituted a non-interactive SDK runtime smoke for the prohibited interactive TUI command. `npm run test:runtime --workspace @narumitw/pi-goal` exercises normal continuation, queued user input, pause during streaming, and manual compaction against a real Pi `AgentSession`; all four scenarios pass.
- [x] Updated `extensions/pi-goal/README.md` with the Pi `0.80.6` requirement, settled lifecycle, pending-message priority, manual-compaction fallback, cancellation semantics, and atomic-reservation limitation.
- [x] Ran `npm run check`; Biome, extension boundaries, all workspace typechecks, and 211 tests passed.

## Risks

- Missed settled wake-ups are mitigated by focused tests and the real-runtime smoke; manual compaction has a verified narrow fallback.
- Pi's public API cannot provide Codex's atomic idle reservation. The accepted limitation is documented, and newer work cancels stale delivery state so the goal can recover on its next `agent_end`.
- `agent_settled` requires Pi `0.80.6` or newer. Package development dependencies and README now state that compatibility floor.

## Rollback / Recovery

The implementation retains isolated intent, delivery, and dispatch helpers. A regression can be rolled back by reverting this plan's source, test, README, and Pi development-dependency changes together; persisted goal entries are unchanged and remain backward-compatible.

## Completion Checklist

- [x] No normal continuation is sent from `agent_end`, verified by source inspection and focused tests.
- [x] Exactly-one settled continuation is verified by repeated-event, failed-dispatch, and lost-start-race tests.
- [x] Pending messages, pause, clear, replacement, completion, budget exhaustion, errors, and compaction cannot launch stale work, verified by targeted tests.
- [x] Supported Pi runtime behavior is verified by `npm run test:runtime --workspace @narumitw/pi-goal`, covering normal, interrupted, queued-input, and manual-compaction flows.
- [x] Documentation and repository checks are verified by README review, `npm run check`, and `just pack-goal`; the dry-run tarball contains only `LICENSE`, `README.md`, `package.json`, and `src/goal.ts`.
