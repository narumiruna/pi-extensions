## Goal

Resolve the three post-merge review findings on PR #215 in a focused follow-up PR without regressing live running-state classification or partial-output visibility.

## Context

PR #215 merged before its final Codex review completed. The remaining findings cover the transition from failed fan-out to fan-in, failed parallel partial output, and timeout reasons in chain partials.

## Plan

- [x] Add focused regression coverage that fails on `origin/main` for a failed fan-out awaiting fan-in, failed parallel output plus its error, and chain timeout errors; `npm test` failed in the new rendering and pending-fan-in regressions (504 passed, 2 failed).
- [x] Represent the pending fan-in transition in execution updates and render errors additively with retained activity/final output across affected collapsed and expanded sibling flows; `npm test` passes 506 tests and the pi-subagents package check passes.
- [x] Scan single, chain, parallel-task, and fan-in rendering for the same error/output exclusivity pattern, run `npm run check`, inspect the final diff, then commit and push PR #217 at `7b08297`.
- [x] Reply to and resolve all three remaining PR #215 review threads with PR #217 and `7b08297` evidence; both Pi 0.79.10 and latest CI jobs pass.

## Risks

- A generic partial-state fallback could make terminal timeout failures look running again. Pending fan-in must therefore be represented explicitly rather than inferred from `isPartial` alone.
- Rendering the error and partial output together must avoid duplicating the same output through both recent activity and `finalOutput`.

## Completion Checklist

- [x] The failed-fanout transition remains visibly running until fan-in emits or settles, while no-aggregator timeout partials remain terminal; verified by execution and rendering regressions.
- [x] Failed single, chain, parallel-task, and fan-in rows retain useful output while surfacing their error reason; verified in collapsed rendering and expanded chain rendering.
- [x] `npm run check` passes 506 tests and both PR #217 CI jobs pass.
- [x] PR #215 has zero unresolved review threads, PR #217 is open and mergeable, and only this completed plan remains to archive.
