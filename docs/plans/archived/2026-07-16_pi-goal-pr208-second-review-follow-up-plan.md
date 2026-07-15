## Goal

Resolve the latest two PR #208 review threads, preserving displaced-goal ownership for budget wrap-up and Pi-owned retry turns, then push verified fixes.

## Context

The finalized-priority guard currently treats every post-priority start as unrelated. The review identifies two owned exceptions: a queued budget wrap-up and an automatic retry still tracked by `goalRecovery`.

## Plan

- [x] Add focused budget-wrap completion/cleanup and Pi-owned retry regressions; the focused queue suite rejected valid wrap-up completion, retained wrap-up blocking after `agent_end`, and omitted the recovering goal prompt on retry.
- [x] Classify budget wrap-up and tracked recovery starts as displaced-goal-owned before finalizing unrelated usage; all 42 focused queue tests and pi-goal typecheck pass.
- [x] Run the repository gate, runtime smoke, package dry run, explicit ignored-source Biome check, and diff validation; `npm run check` passed 500 tests, runtime smoke passed, and `just pack-goal` produced the expected 12-file package.
- [x] Commit and push the fixes, reply to and resolve both latest PR #208 threads, and confirm final CI/thread state; commit `40aa678` is pushed, both threads are resolved, and both Pi 0.79/latest jobs pass.

## Risks

- Owned exceptions must remain narrow so ordinary user turns cannot resume displaced-goal accounting.
- Budget wrap-up cleanup must still occur when no valid completion tool is called.

## Completion Checklist

- [x] Both latest PR #208 findings have focused regression coverage; all 42 queue tests and pi-goal typecheck pass.
- [x] Repository, runtime, packaging, formatting, and diff checks pass with the evidence recorded above.
- [x] Commit `40aa678` is pushed, all PR #208 threads are resolved, and both CI jobs pass.
