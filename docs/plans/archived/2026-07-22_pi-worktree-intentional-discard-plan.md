## Goal

Make `pi-worktree` remove and prune usable when only administrative recovery history is unreachable, while retaining hard safety stops for dirty worktree/index state, locks, missing branch tips, and unreachable detached HEADs.

## Context

The current flows reject every unreachable OID found in administrative reflogs. Normal rebases and resets leave reflog-only commits, so otherwise clean removal and stale-metadata pruning can become impossible through the extension.

## Plan

- [x] Add red-first command regressions showing remove and prune name reflog-only OIDs in their mutation confirmation, proceed only after approval, and reject changed risk state; the two behavior tests first failed on hard refusal, then the final root run passed all 1,078 tests including remove-history and prune-preview race regressions.
- [x] Change the shared administrative-history check to return confirmation risks while preserving hard guards for staged indexes and current branch/detached HEAD state; package typecheck and missing-branch/detached/index command tests pass.
- [x] Update the README to distinguish hard safety stops from explicitly discardable recovery history; `npm run check --workspace @narumitw/pi-worktree` passes and `just pack-worktree` contains the intended seven package files.
- [x] Run the full repository gate and a bounded adjacent race/safety review; `npm run check` passes all 1,078 tests and the review added exact risk-set, administrative-path, missing-ref, and dry-run-preview guards.

## Risks

- Confirmation must bind the exact OIDs and prune preview so state appearing after approval is not silently discarded.
- The UI must make clear that Git objects are not deleted immediately, but their worktree-owned recovery pointers are removed and the objects may later be garbage-collected.

## Completion Checklist

- [x] Clean remove and stale prune can proceed after explicit approval of named reflog-only recovery loss, verified by command tests that assert full OIDs and successful mutations.
- [x] Cancellation or changed administrative state prevents mutation, and staged/index/current-HEAD hazards still fail closed, verified by cancellation, race, staged-index, missing-ref, and detached-HEAD tests.
- [x] Documentation, package validation, and the full repository check pass, verified by the package check, seven-file pack dry run, and 1,078-test root gate.
