## Goal

Resolve both open review threads on PR #208, verify finalized-priority ownership across reload and manual compaction, and push the fixes to the existing PR.

## Context

The review identifies two paths that do not yet honor persisted `displacedUsageFinalized`: a post-reload `agent_end` can mutate the displaced goal, and idle manual compaction can return before dispatching the pending priority.

## Plan

- [x] Add focused reload/agent-end and finalized manual-compaction regressions; the focused queue suite failed with an unowned iteration increment after reload and a priority left undispatched after manual compaction.
- [x] Update lifecycle ordering so finalized pending priority blocks all `agent_end` mutations while still allowing idle compaction dispatch; all 39 focused queue tests and pi-goal typecheck pass.
- [x] Run the repository gate, runtime smoke, package dry run, explicit ignored-source Biome check, and diff validation; `npm run check` passed 497 tests, runtime smoke passed, and `just pack-goal` produced the expected 12-file package.
- [x] Commit and push the fixes, reply to and resolve both PR #208 threads, and confirm final CI/thread state; commit `1067c86` is pushed, both threads are resolved, and both Pi 0.79/latest jobs pass.

## Risks

- The compaction fix must dispatch only through the existing idle/pending-message gate.
- The reload guard must not suppress a genuinely goal-owned run before displaced usage is finalized.

## Completion Checklist

- [x] Both PR #208 findings have focused regression coverage; all 39 queue tests and pi-goal typecheck pass.
- [x] Repository, runtime, packaging, formatting, and diff checks pass with the evidence recorded above.
- [x] Commit `1067c86` is pushed, both review threads are resolved, and PR #208 is clean with both CI jobs passing.
