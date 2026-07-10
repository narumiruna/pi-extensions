## Goal

Bring `@narumitw/pi-goal` closer to the current Codex Goal contract without porting Codex's SQLite runtime. Success means continuation starts only from a safe idle boundary, stopped outcomes are distinguishable and resumable, budget usage is trustworthy, and every goal prompt applies the same evidence-based completion standard.

## Context

This is the entry plan for the improvement program. Execute the linked plans as separate, reviewable slices in this order:

1. [Idle continuation](./archived/2026-07-10_pi-goal-idle-continuation-plan.md) — completed
2. [Stopped statuses](./2026-07-05_pi-goal-stopped-statuses-plan.md)
3. [Budget accounting](./2026-07-10_pi-goal-budget-accounting-plan.md)
4. [Prompt hardening](./2026-07-05_pi-goal-continuation-prompt-hardening-plan.md)

The order is intentional: prompt text must describe states and controls that already exist, while accounting and continuation changes should land before wording claims Codex-like behavior.

## Architecture

Keep the implementation as a Pi extension with session-entry persistence and one `/goal` command. Preserve the UUID stale-turn guard and nonce-based continuation cancellation. Use Pi's settled/idle lifecycle for scheduling, add Codex-inspired stopped states locally, and define token/elapsed usage in extension-owned state rather than introducing a global database.

## Non-Goals

- Do not port Codex's SQLite goal store, app-server RPC API, analytics, or TUI.
- Do not modify `third_party/codex`.
- Do not remove `goal_complete({ goal_id, summary })` or weaken its stale-turn checks.
- Do not claim exact Codex parity where Pi lacks a hidden-context or runtime-reservation API.
- Do not update the external article unless its source is later added to this repository.

## Plan

- [x] Executed the idle-continuation plan: ordinary continuation now leaves `agent_end` and starts only after Pi is settled; verified by focused tests, the real `AgentSession` runtime smoke, `npm run check`, and `just pack-goal`.
- [ ] Execute the stopped-statuses plan so `paused`, `blocked`, `usage_limited`, `budget_limited`, and `complete` have distinct transitions and resume behavior; verify with its state, tool, and interruption tests.
- [ ] Execute the budget-accounting plan so cached/total tokens, active elapsed time, tool-boundary exhaustion, and wrap-up behavior have documented semantics; verify with its accounting tests.
- [ ] Execute the prompt-hardening plan after stopped statuses exist so kickoff, resume, edit, system, continuation, blocker, and budget prompts all match implemented behavior; verify with prompt snapshots/assertions.
- [ ] Reconcile `extensions/pi-goal/README.md` with the final command surface, all statuses, interruption semantics, token definition, visible-versus-hidden continuation limitation, and completion contract; verify every documented command and status against source tests.
- [ ] Run the CI-equivalent gate and package preview after all slices land; verify with `npm run check` and `just pack-goal`, then inspect that the tarball contains only `src`, `README.md`, `LICENSE`, and package metadata.

## Risks

- Moving continuation later can expose missed wake-ups unless every active, eligible goal reaches a settled callback.
- New stopped states change statusline text consumed by other extensions.
- Counting provider `totalTokens` can make existing budgets exhaust sooner than users expect.
- Stronger prompts increase recurring context cost; keep shared sections concise and tested.

## Rollback / Recovery

Land each linked plan as an independent change. If a slice regresses runtime behavior, revert that slice while preserving earlier completed slices. Keep persisted-state readers backward-compatible throughout so rollback does not make existing sessions unreadable.

## Completion Checklist

- [x] Safe continuation is verified by the completed and archived idle-continuation plan, 211 passing repository tests, and the four-scenario runtime smoke.
- [ ] Distinct stopped statuses are verified by the completed and archived stopped-statuses plan plus state-transition tests.
- [ ] Correct token and active-time accounting is verified by the completed and archived budget-accounting plan plus boundary tests.
- [ ] Consistent evidence-based prompts are verified by the completed and archived prompt-hardening plan plus prompt assertions.
- [ ] Public documentation and package contents are verified by README review, `npm run check`, and `just pack-goal` output.
- [ ] All linked plans are archived under `docs/plans/archived/` only after their own completion evidence is recorded.
