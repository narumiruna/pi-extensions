## Goal

Make detached `pi-subagents` coordination follow Codex's critical-path policy: spawn only work that can overlap useful root work, wait only when the next required step is blocked, and deliver completion asynchronously without autonomously starting recovery turns.

## Context

The current prompt tells the root agent to call `subagent_wait` whenever no useful local continuation remains, and the runtime queues an idle recovery continuation while delegated work is live or awaiting synthesis. Together these make the root agent wait reflexively even though detached completion already uses `triggerTurn: false` delivery.

## Non-Goals

- Do not change the blocking `subagent` batch API.
- Do not change stateful agent persistence, transport, mailbox, or explicit `subagent_wait` semantics.
- Do not remove lifecycle tools or prevent an explicit critical-path wait.

## Plan

- [x] Add regression expectations for Codex-style spawn guidance and absence of autonomous root recovery; the red focused run failed because recovery sent two root messages instead of zero.
- [x] Remove idle orchestration recovery while retaining asynchronous completion delivery and explicit waits; 35 focused stateful/prompt tests pass, including `deliverAs: "steer"` with `triggerTurn: false` and explicit waiter coverage.
- [x] Update tool guidance, spawn output, and README documentation to require useful overlapping root work and reserve `subagent_wait` for immediate critical-path blockers; focused prompt-contract tests and README inspection pass.
- [x] Run repository verification and inspect the final diff for bounded behavior changes; `npm run check` passes 957 tests, `git diff --check` passes, and `just pack-subagents` contains the expected 22 files without the removed recovery module.

## Risks

- A root turn that finishes before a detached result arrives will no longer be autonomously resumed; the completion remains queued for an active or later turn by design.
- Weak guidance could still let a model wait reflexively; executable prompt-contract tests must preserve the critical-path-only wording.
- Removing recovery must not suppress the existing detached completion message or explicit waiter result.

## Completion Checklist

- [x] Detached spawn no longer causes `sendUserMessage` recovery calls, verified by the passing registered detached-spawn lifecycle test.
- [x] Completion still uses `deliverAs: "steer"` and `triggerTurn: false`, verified by the passing registered detached-spawn lifecycle test.
- [x] Main and spawn tool guidance say to wait sparingly and only for an immediate blocked critical-path step, verified by passing prompt-contract tests.
- [x] User documentation describes queued next-turn behavior instead of idle recovery, verified by README inspection and stale-wording search.
- [x] The complete repository gate passes with no whitespace errors, verified by `npm run check` (957 tests) and `git diff --check`.
