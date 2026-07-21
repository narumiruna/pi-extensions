## Goal

Resolve confirmed PR #312 review findings without allowing legacy pi-sync writers to overlap a guarded sync.

## Plan

- [x] Add failing regressions for an aged legacy writer, unreadable doctor state, and orphan-guard diagnostics; all three failed against the prior PR head.
- [x] Require explicit stale unlock for unreadable metadata and expose structured lock inspection to callers; verified with the focused 35-test pi-sync suite.
- [x] Make doctor and unlock diagnostics distinguish unreadable metadata, active owners, and exited owners with an expiring guard; verified with focused command tests.
- [x] Run explicit formatting/typechecks, `npm run check`, and `just pack-sync`; explicit Biome, typechecks, 977-test gate, package dry run, and independent review pass.
- [x] Commit and push the review fixes to PR #312; commit `24f9199` is pushed and GitHub CI run `29847110843` passes.

## Completion Checklist

- [x] All confirmed findings have deterministic regression coverage in `extensions/pi-sync/test/sync.test.ts`.
- [x] `npm run check` passes with 977 tests.
- [x] `just pack-sync` includes the lock module and dependency metadata.
- [x] PR #312 contains commit `24f9199` and has passing CI.
