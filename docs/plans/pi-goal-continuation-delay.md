# Pi Goal continuation delay

## Objective

Add a supported `continuationLimits.minIntervalMs` setting so automatic Goal continuations can wait before dispatching.

The default remains `0`, preserving current behavior.

## Implementation

1. Add and atomically persist a non-negative safe-integer `minIntervalMs` setting.
2. Expose the setting in the existing Goal Settings menu.
3. Reuse GoalRuntime's owned continuation timer for delayed dispatch.
4. Cancel the timer through existing continuation cancellation and session-shutdown paths.
5. Keep exact runtime-generation and goal-ID checks before dispatch.
6. Document the setting and add a minor Changeset.

## Success criteria and verification

- **No overengineering:** reuse `continuationDispatchTimer`; add no companion extension, queue, or second scheduler.
- **Behavioral tests:** prove no continuation before the interval, dispatch at the interval, and no dispatch after pause/replacement/shutdown.
- **Reusable ownership:** settings parsing, UI, persistence, and runtime scheduling each retain one source of truth.
- **SDD and TDD:** this repository has no `sdd/`; write failing settings/runtime/UI tests before production changes and verify through upstream CI.
- `continuationLimits.automaticTurns: 10` and `continuationLimits.minIntervalMs: 60000` load together from `pi-goal.json`.
