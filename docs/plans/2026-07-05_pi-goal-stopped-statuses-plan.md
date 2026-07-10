## Goal

Add Codex-inspired stopped statuses to `@narumitw/pi-goal`: `blocked` for true impasses and `usage_limited` for provider/account quota limits.

Success means users can distinguish intentional pause, model-reported blocker, usage-limit stop, budget-limit stop, and completion; `/goal resume` can restart resumable stopped states safely.

## Context

`pi-goal` currently has `active`, `paused`, `budget_limited`, and `complete`. Non-retryable aborted/error turns are generally paused, and there is no model-facing way to stop an active goal as blocked. Codex uses `blocked` and `usage_limited` in `third_party/codex/codex-rs/protocol/src/protocol.rs` and `third_party/codex/codex-rs/ext/goal/src/tool.rs`, with prompt rules requiring repeated blocker evidence before `blocked`.

## Architecture

Extend the local goal state machine in `extensions/pi-goal/src/goal.ts` without adding Codex's SQLite store. Add a small model-facing blocked tool or status-update helper that can only mark the current matching goal `blocked`; keep `goal_complete` dedicated to successful completion.

Suggested status semantics:

- `paused`: user-initiated pause or user abort/interruption.
- `blocked`: model or non-usage terminal error indicates work cannot proceed without user/external action.
- `usage_limited`: provider/account usage limit stops the goal.
- `budget_limited`: user-configured goal token budget is exhausted.
- `complete`: goal is achieved and verified.

## Non-Goals

- Do not implement exact Codex SDK logical goal streams.
- Do not persist a global per-directory goal database.
- Do not make `blocked` a substitute for ordinary clarification; the prompt/tool contract must preserve strict blocker semantics.

## Unknowns

- Whether to name the new model-facing blocked tool `goal_blocked` or to introduce a broader `goal_update` tool. Resolve during implementation by choosing the smaller API that keeps `goal_complete` backward-compatible.

## Plan

- [ ] Add failing tests in `extensions/pi-goal/test/goal.test.ts` for `blocked` and `usage_limited` formatting, `/goal resume` eligibility, stale tool-call blocking after stopped states, and usage-limit classification; verify initial failures with `npm test`.
- [ ] Extend `GoalStatus`, `isGoal()`, `formatStatus()`, `goalSummary()`, and `goalCommandHint()` in `extensions/pi-goal/src/goal.ts` to support `blocked` and `usage_limited`; verify formatting tests cover active/paused/blocked/usage_limited/budget_limited/complete.
- [ ] Update command behavior so `/goal resume` accepts `paused`, `blocked`, `usage_limited`, and budget-limited goals when budget allows, while `/goal pause` remains active-only; verify command tests assert accepted and rejected statuses.
- [ ] Add a model-facing blocker path, either `goal_blocked({ goal_id, reason, evidence, repeated_turns })` or `goal_update({ goal_id, status: "blocked", ... })`, that rejects stale ids, empty evidence, and `repeated_turns < 3`; verify with tool execution tests.
- [ ] Split interruption classification so user aborts stay `paused`, provider/account quota messages become `usage_limited`, and non-retryable agent errors become `blocked` with a clear notification; verify with targeted `agent_end` tests for each stop reason.
- [ ] Update stale tool-call blocking to apply to stopped states caused by in-flight work (`paused`, `blocked`, `usage_limited`) until a fresh user prompt, resume, or clear; verify existing stale-call tests plus new blocked/usage-limited cases.
- [ ] Update `extensions/pi-goal/README.md` statusline states, command descriptions, and interruption behavior for `blocked` and `usage_limited`; verify examples align with `formatStatus()` output.
- [ ] Run `npm run check` from the repository root and fix any formatting, type, or test failures.

## Risks

- A model-facing blocked tool may be overused unless the prompt and tool schema are strict.
- Automatically mapping generic errors to `blocked` could surprise users who expect `/goal resume` after transient provider issues; tests should preserve retryable interruption behavior.
- Statusline consumers may need to tolerate new plain-text values such as `blocked` and `usage`.

## Completion Checklist

- [ ] `pi-goal` state supports `blocked` and `usage_limited`, verified by TypeScript type checks and `isGoal()` persistence tests.
- [ ] Users can resume `paused`, `blocked`, and `usage_limited` goals with `/goal resume`, verified by command tests.
- [ ] The model can mark a current goal blocked only with matching goal id and sufficient blocker evidence, verified by tool tests.
- [ ] Usage-limit interruptions produce `usage_limited` instead of generic `paused`, verified by `agent_end` interruption tests.
- [ ] Retryable provider/context-overflow interruptions remain active and do not become stopped states, verified by existing retry tests.
- [ ] README and statusline examples document all stopped statuses, verified by review of `extensions/pi-goal/README.md`.
- [ ] Repository verification passes with `npm run check`.
