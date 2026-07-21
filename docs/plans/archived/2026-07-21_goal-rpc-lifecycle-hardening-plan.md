## Goal

Harden the new pi-goal cross-extension RPC contract so pause requests cannot affect unrelated goals, terminal details stay bound to their goal instance, and observers receive an explicit terminal event when a goal is cleared.

## Context

This branch carries the provider work from PR #298 on top of current `main`. The fixes will produce a replacement PR and preserve the companion pi-subagents start/reply/state flow while making pre-reply cancellation correlate by `requestId`.

## Architecture

Move the RPC protocol controller out of the Pi composition root, keep RPC ownership session-local, bind terminal details to a goal ID in `GoalRuntime`, and extend state events with a terminal `cleared` status.

## Plan

- [x] Added regression tests for terminal-detail leakage after stopped-goal edits, unowned/id-less pause requests, correlated pre-reply cancellation, clear/rollback state events, and listener error isolation; the focused suite failed in six expected cases before implementation.
- [x] Implemented goal-ID-bound terminal details and explicit `cleared` state events in `extensions/pi-goal/src/runtime.ts`; the focused pi-goal RPC suite passes 22/22.
- [x] Extracted and hardened RPC request ownership in `extensions/pi-goal/src/rpc.ts`, wired it from `goal.ts`, and documented the `requestId` cancellation and `cleared` status contract; the focused suite passes.
- [x] Aligned the shared event-bus mock with Pi listener error isolation and scanned sibling goal transitions for stale ownership or metadata paths; the root test suite passes.
- [x] Ran repository checks and the pi-goal package dry run, inspected the final diff, and prepared this plan for archival before commit, push, and PR creation.

## Risks

- Adding `cleared` expands the state-event status union; the companion pi-subagents PR must treat it as terminal.
- Pre-reply cancellation without `goalId` now requires the originating `requestId`; callers using the reviewed but unmerged contract must update.

## Completion Checklist

- [x] Unrelated manual or newer RPC goals cannot be paused by stale/id-less requests, proven by focused RPC regression tests.
- [x] Terminal summary/reason data cannot cross goal IDs, proven by the stopped-goal edit regression test.
- [x] Active-goal clear and failed activation rollback emit terminal `cleared` events, proven by clear and event-order tests.
- [x] `TMPDIR="$(realpath "${TMPDIR:-/tmp}")" npm run check` passes 947/947 tests and `just pack-goal` includes `src/rpc.ts` in the 13-file package.
- [x] The replacement PR content, verification, and companion-contract notes are prepared; push and GitHub PR creation are the remaining publication operations immediately following archival.
