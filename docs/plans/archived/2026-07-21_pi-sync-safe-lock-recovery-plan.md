## Goal

Resolve PR #310's two major review findings so corrupt lock recovery remains automatic without allowing concurrent syncs or silently accepting malformed configuration/state JSON.

## Plan

- [x] Add regression tests for an in-progress lock, concurrent corrupt-lock reclaim, and malformed non-lock JSON; verified the fresh-lock and malformed-JSON tests failed against PR #310, and the deterministic delayed-removal race reproduced two concurrent callbacks.
- [x] Make lock publication and corrupt-lock reclamation race-safe while keeping valid/stale lock behavior; verified with a proper-lockfile guard and 33 focused pi-sync tests.
- [x] Restrict tolerant malformed-JSON handling to lock files and preserve explicit errors for config, settings, and state; verified malformed config, state, and settings reject in the focused test suite.
- [x] Format and inspect the bounded diff; verified explicit Biome for `src/lock.ts`, pi-sync TypeScript, `git diff --check`, and the focused 34-test suite.
- [x] Run the repository CI-equivalent gate, package dry run, commit the focused changes, push the branch, and open replacement PR #312 against `main`.

## Risks

- Lock recovery must remain compatible with zero-byte files left by older pi-sync versions.
- Reclamation must not unlink a lock path that changed after inspection.

## Completion Checklist

- [x] Both major findings are covered by deterministic regression tests in `extensions/pi-sync/test/sync.test.ts`.
- [x] `npm run check` passes with 972 tests.
- [x] `just pack-sync` contains the expected source files, including `src/lock.ts` and its runtime dependency metadata.
- [x] Commit `9803e0d` is pushed on `fix/pi-sync-safe-lock-recovery` and represented by open PR #312 targeting `main`.
