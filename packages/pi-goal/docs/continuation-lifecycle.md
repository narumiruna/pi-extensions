# pi-goal interruption and continuation lifecycle

[Back to README](../README.md)

This note records the current lifecycle contract behind `@narumitw/pi-goal`. It explains the
extension's settled-boundary dispatcher, retry and compaction ownership, and the remaining races in
that idle-dispatch design. It does not describe every continuation API available in Pi.

## Scope and authority

Source and test paths below are relative to the repository root. Tests are not included in the published package.

The maintained implementation and tests are authoritative:

- `packages/pi-goal/src/goal.ts`
- `packages/pi-goal/src/lifecycle.ts`
- `packages/pi-goal/src/runtime.ts`
- `packages/pi-goal/src/tools.ts`
- `packages/pi-goal/src/tool-policy.ts`
- `packages/pi-goal/src/accounting.ts`
- `packages/pi-goal/src/safety.ts`
- `packages/pi-goal/src/prompts.ts`
- `packages/pi-goal/src/goal-contract.ts`
- `packages/pi-goal/src/workflow-mutex.ts`
- `packages/pi-goal/test/goal-continuation.test.ts`
- `packages/pi-goal/test/goal-error-lifecycle.test.ts`
- `packages/pi-goal/test/goal-wait.test.ts`
- `packages/pi-goal/test/goal-run-protocol.test.ts`
- `packages/pi-goal/test/goal-cache-contract.test.ts`
- `packages/pi-goal/test/workflow-mutex.test.ts`
- `test/plan-goal-coexistence.test.ts`
- `packages/pi-goal/test/goal-runtime-smoke.mjs`

The package README owns the public command, settings, status, and interruption contract. This note
keeps only the internal lifecycle rationale and public-API boundaries.

## Settled continuation contract

`pi-goal` separates outcome classification from continuation dispatch:

1. `turn_end` accounts every completed model response owned by automatic Goal work and enforces an
   optional configured response cap.
2. `agent_end` records final usage, classifies the run outcome, applies the no-progress guard, and
   creates an in-memory continuation intent for an eligible active goal. It does not send the normal
   continuation.
3. `agent_settled` runs after retry, automatic compaction, steering, and follow-up work drains.
   It moves exhausted provider recovery into deadline-free waiting, blocks exhausted compaction recovery, and then may dispatch an ordinary continuation.
4. Continuation dispatch re-reads the active goal, requires matching ownership, `ctx.isIdle()`, and
   no pending messages. Repeated settled events cannot consume one intent twice.

Standalone manual compaction does not emit `agent_settled`, so `session_compact` invokes the same
single-flight idle dispatcher as a narrow fallback. It does not introduce a second continuation
path or bypass the idle and pending-message gates.

## Ownership and stale-delivery protection

Goal-owned kickoff, resume, active-edit, and continuation prompts carry bounded markers tied to the
originating goal id. Continuation tickets also include the goal iteration and a unique nonce. Intent
and accepted delivery are tracked separately so cancellation can cover both a not-yet-dispatched
continuation and a prompt that was accepted by Pi but lost the non-atomic start race.

At `input`, `before_agent_start`, and later lifecycle boundaries, the runtime revalidates the active
goal id, prompt marker, status, and run ownership before mutating state. Session replacement
separately clears pending prompt, continuation, recovery, and run ownership. A newer user or extension
turn can supersede old continuation intent. A delayed prompt from a replaced, stopped, cleared, or
completed goal cannot reactivate work or overwrite a newer goal.

Goal's idle dispatcher does not atomically reserve a turn. Another extension can still win after
`ctx.isIdle()` and pending-message checks. Goal markers, start-boundary revalidation, and later fresh
intent recovery bound this race. This is a limit of the current dispatcher, not proof that Pi has no
public continuation boundary; see [Public continuation boundary and remaining limits](#public-continuation-boundary-and-remaining-limits).

Goal also participates independently in the anonymous `workflow:mutex:v1` protocol.
An active or waiting Goal retains cooperative ownership across normal work, continuation delivery, compaction, and provider recovery.
Admission rejects another cooperating workflow before Goal state, tools, persistence, prompts, status, or timers change.
The mutex does not reserve a Pi turn and cannot coordinate trusted extensions that do not participate in the protocol.

## Stable helper-tool envelope

`goal_complete`, `goal_blocked`, and `goal_wait` are registered once and keep stable provider-visible schemas from startup.
Their visibility alone does not activate Goal mode because each tool requires the latest effective active Goal contract and matching goal id.
The extension does not add mode-only `promptSnippet` or `promptGuidelines` metadata and does not mutate the active tool set during Goal lifecycle transitions.
A restrictive external allowlist can still hide Goal tools; Goal start and restore require `goal_complete` and `goal_blocked` without widening that allowlist, while `goal_wait` remains optional for ordinary Goal work.

## Retry, compaction, and stopped states

Retryable provider failures and context-overflow compaction remain Pi-owned recovery:

- `agent_end` keeps the matching goal active, cancels ordinary continuation pressure, and records
  recovery ownership instead of blocking retry tools.
- A retry or compaction start consumes or carries that ownership into the replacement run so
  automatic accounting cannot be bypassed.
- If matching provider recovery remains when `agent_settled` proves no retry or follow-up is pending, the Goal enters deadline-free waiting while remaining canonically active.
- A non-Goal follow-up wakes the same Goal and preserves its stale-turn guard so the next model run can continue, complete, or wait again.
- If matching compaction recovery remains at settlement, the Goal becomes `blocked` because another model turn can repeat the same context-overflow failure without corrective compaction.
- Explicit subscription, quota, credit, or billing exhaustion becomes `usage_limited`; transient rate limits and server failures remain retryable.
- User interruption becomes `paused`. Other terminal non-usage failures become `blocked`.

Provider-exhaustion waiting cancels continuation pressure but retains Goal identity and Workflow Mutex ownership.
Stopped transitions cancel current continuation ownership and block stale Goal-owned tool calls.
Successful stopped-state resume rotates the goal id and starts a fresh blocker and safety audit.
Waiting resume preserves the goal id, while clear removes Goal state and stale guards without aborting unrelated work.

## Compaction persistence

Canonical Goal state is stored in `goal-state` session entries. Before compaction, the runtime
checkpoints active elapsed time and current safety/accounting state. Automatic compaction retries do
not enqueue another Goal turn. Non-retrying manual compaction creates at most one fresh intent and
uses the common idle dispatcher. Old queue metadata in `goal-state` or legacy `goals-state` entries
is treated as inert legacy data and never dispatches automatic work.

Goal prompts and compacted context use the same objective trust boundary, stale goal id, full-scope rule, and requirement-by-requirement completion audit.
On idle activation, the first accepted handoff publishes its versioned hidden `goal-contract` at `before_agent_start`, after retained conversation history.
An accepted kickoff or edit while the agent is busy publishes the contract once with `triggerTurn: false`. The queued follow-up claims run ownership at `message_start`; it does not require a new `before_agent_start`.
Pi can defer persistence until after newer output. The contract records its send time, and context projection restores its effective turn-boundary position without splitting tool calls from their results.
Every active or inactive contract explicitly supersedes earlier contracts. Immediate and deferred publication preserve the existing model-visible prefix; historical contracts are not replaced with mutable state.
Failed Goal handoff delivery publishes no contract for that undelivered handoff.
Stopped transitions persist one inactive revision, but terminal Goal tools defer that revision until `turn_end` so Pi first persists the real `goal_complete` or `goal_blocked` tool result.
This ordering prevents a synthetic missing-result fallback from appearing before the inactive contract in later provider input.
The `context` hook supplies one missing current revision after all retained messages as a correctness fallback, and reconciles deferred publication to the turn boundary described above.
Compaction and session restore persist a missing current revision without waking an external wait.
Mutable accounting remains outside the retained provider prompt prefix.
Prompt wording is a guardrail; current files, commands, tests, runtime behavior, and external state remain the completion evidence.

## Usage, elapsed time, and circuit breakers

For each persisted assistant message, accounting prefers a finite non-negative
`usage.totalTokens`. Older or partial records fall back to finite non-negative
`input + output + cacheRead + cacheWrite`, without adding fields already included in those totals.
Goal usage subtracts the branch baseline captured at activation and clamps branch rewinds at zero.

`tool_execution_end` is the earliest reliable in-turn budget boundary because Pi persists the assistant message before this hook.
Budget exhaustion transitions once to `budget_limited`, aborts the current turn, cancels owned continuation and recovery work, blocks stale Goal tools, and releases Workflow Mutex ownership.
It does not inject a wrap-up or schedule another model request; `agent_end` is the no-tool fallback.
Active elapsed time is accumulated only while status is `active` and not waiting, excluding quiet waits, stopped states, shutdown, and offline periods.

Automatic-work safety is separate from the token budget:

- `continuationLimits.automaticTurns` defaults to `25`; explicit `null` selects Unlimited, and `turn_end` counts normal responses from automatic continuations, including tool loops and matching recovery work.
- `continuationLimits.noProgressTurns` defaults to `3`. Repeated empty or normalized-identical
  tool-free automatic runs pause the goal; attempted tool calls reset that heuristic.
- The no-progress fingerprint is fixed-size and stores no raw assistant text.
- Safety state persists across reload and compaction. It resets only at documented successful
  user-control boundaries.

These guards pause rather than infer completion. `goal_complete` remains authoritative because plain
assistant text cannot prove filesystem, test, runtime, PR, rendered, or external requirements.

## Public continuation boundary and remaining limits

Pi exposes `agent_before_settle` as an actionable boundary after recovery and queued work drain.
Handlers can append boundary entries and return `continue: true` for one next model request within
the current run. Pi's current extension guide assigns continuation to that boundary and
notification-only work to `agent_settled`.

Goal still dispatches from `agent_settled` through an idle-gated message send. Its residual send race
belongs to that implementation choice, not an unavoidable absence of a public Pi continuation API.
Moving to `agent_before_settle` would be a separate runtime change that must verify ownership,
recovery, waiting, accounting, cancellation, and exactly-once behavior; this note does not claim that
migration is implemented or verified.

The existing dispatcher does not reserve an idle turn, add a Goal-aware abort event or queue
priority, or globally schedule every extension. The cooperative Workflow Mutex cannot control
non-participating extensions, and later boundary handlers can override a continuation proposal.

## Verification map

- Settled exactly-once dispatch, pending-message priority, replacement, pause, clear, and lost-start races: `packages/pi-goal/test/goal-continuation.test.ts`.
- Workflow Mutex acquisition, rejection before mutation, restore fallbacks, release, and reacquisition: `packages/pi-goal/test/workflow-mutex.test.ts` and the Goal package lifecycle tests.
- Stable helper-tool schemas and restrictive allowlist behavior: `packages/pi-goal/test/goal-tool-policy.test.ts` and `packages/pi-goal/test/tool-policy.test.ts`.
- Stable leading prompt prefix, immediate and deferred handoff publication, canonical context reinjection, compaction-sensitive Goal contracts, and terminal tool-result ordering: `packages/pi-goal/test/goal-cache-contract.test.ts`.
- Retry, overflow, compaction, provider-exhaustion waiting, wake-up, restored waiting, and stopped-state classification: `packages/pi-goal/test/goal-error-lifecycle.test.ts`.
- External-wait deadlines, cleanup, quiet elapsed time, and wake boundaries: `packages/pi-goal/test/goal-wait.test.ts`.
- Managed-run active waiting and later terminal completion: `packages/pi-goal/test/goal-run-protocol.test.ts`.
- Budget exhaustion without a wrap-up or extra model request: `packages/pi-goal/test/goal-budget-lifecycle.test.ts`.
- Usage totals, active time, tool-boundary budgets, and safety epochs: the accounting, budget, safety, persistence, and settings tests under `packages/pi-goal/test/`.
- Real Pi event ordering, retries, manual compaction, no-progress stopping, automatic tool loops, and
  bounded pre-aborted cleanup: `packages/pi-goal/test/goal-runtime-smoke.mjs`.
