## Goal

Resolve every open review thread on PR #173, verify the fixes, reply to and resolve the threads, then commit and push the branch.

## Context

Two open comments identify queue-lifecycle races: restored pending actions can be blocked by an exhausted old head, and an already-queued owned prompt can start after its goal is skipped.

## Plan

- [x] Add focused regressions for restored skip/prioritize actions crossing the old head's budget and for queued owned prompts arriving after skip; focused `goal-queue.test.js` run failed in all three new regressions against the current implementation.
- [x] Fix `extensions/pi-goal/src/goal.ts` event ordering so pending restored actions dispatch before old-head budget limiting and skipped owned prompts are consumed and aborted; all 30 focused queue tests pass, including session-start and manual-compaction regressions.
- [x] Scan adjacent queue lifecycle paths and run the repository verification gate plus package dry run; `npm run check` passed 488 tests, runtime smoke passed, `just pack-goal` produced the expected 12-file package, and `git diff --check` passed.
- [x] Commit and push the focused changes, reply to both review comments with evidence, resolve both threads, and confirm PR checks/review-thread state through GitHub; commit `8a27559` is pushed, both threads are resolved, and both Pi 0.79/latest checks pass.

## Risks

- Mitigated: focused skip/prioritize restoration tests assert queue order and active status after dispatch.
- Mitigated: paired prompt tests assert that owned skipped-goal work aborts while unrelated user work does not.

## Completion Checklist

- [x] Both reported races have regression coverage that passes after the implementation change in the focused 30-test queue suite.
- [x] Repository checks, pi-goal runtime smoke tests, package dry run, and diff validation pass with the evidence recorded above.
- [x] The branch is pushed at `8a27559`, PR #173 has no unresolved review threads, and both required CI jobs pass.
