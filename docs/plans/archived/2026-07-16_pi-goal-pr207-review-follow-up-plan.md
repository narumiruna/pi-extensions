## Goal

Resolve every review finding on PR #207, verify the ownership fix across adjacent lifecycle paths, and open a replacement PR against `main`.

## Context

The open review notes that `agentRunGoalId = null` prevents `agent_end` accounting for an unrelated turn while priority is pending, but `tool_execution_end` can still charge that turn to the displaced goal.

## Plan

- [x] Add a focused regression proving tool-using unrelated turns cannot accrue displaced-goal usage while priority is pending; the focused queue suite failed with 25 unrelated tokens charged against PR #207.
- [x] Centralize and persist the unowned-run accounting boundary, then inspect adjacent command, compaction, shutdown, restoration, failed activation, and terminal-tool paths; all 46 focused queue/persistence tests and pi-goal typecheck pass.
- [x] Run the repository gate, runtime smoke, package dry run, explicit ignored-source Biome check, and diff validation; `npm run check` passed 496 tests after preserving the accounting helper's status-dependent clock default, runtime smoke passed, and `just pack-goal` produced the expected 12-file package.
- [x] Commit and push a replacement branch, open a new PR against `main`, reply to and resolve PR #207's review thread, and close PR #207 as superseded; commit `2eca716` is pushed in PR #208 and PR #207 is closed with no unresolved threads.

## Risks

- Existing goal-owned runs must continue accounting normally; the focused test will retain the existing owned-run coverage alongside the new unowned tool path.
- The replacement PR must preserve all verified fixes from PR #207 without introducing duplicate open merge candidates.

## Completion Checklist

- [x] PR #207's finding and adjacent ownership/restoration paths have regression coverage; all 46 focused queue/persistence tests and pi-goal typecheck pass.
- [x] Repository, runtime, packaging, formatting, and diff checks pass with the evidence recorded above.
- [x] PR #208 is open and clean with both Pi 0.79/latest CI jobs passing; PR #207 is closed as superseded with no unresolved threads.
