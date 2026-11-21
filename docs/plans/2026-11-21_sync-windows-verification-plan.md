# Sync Windows verification fixes

## Goal

Create a focused follow-up PR against `narumi/feat/pi-sync-ignore-file` that fixes the Windows verification blockers found at `d27317a`, without enabling draft ignore-policy setup or migration.

## Context

The native Windows report reproduced unsafe launcher assumptions and four failures in the new ignore-policy tests. Recovery restored file bytes but retained a v11 journal because NTFS changed the staged file's creation time during rename. The broader Windows baseline had 989 test failures and is not part of this repair.

## Applicable requirements

- Runtime recovery: preserve transaction evidence, exact byte checks, ownership, cancellation, and stale-state checks (`packages/pi-sync-daemon/AGENTS.md`; `Review`, deterministic `Test`, native `Smoke`).
- File settings: preserve atomic same-directory publication, unknown data, invalid-file protection, and existing activation gates (`docs/extension-settings.md`; `Review` and `Test`).
- UI verification: retain RPC native-path guidance, non-TUI behavior, cancellation, and the existing manual CRLF editing fallback (`docs/extension-conventions.md`; `Test` and `Review`).
- Runtime packaging: keep generated imports exact and daemon artifacts fresh; run build, package-content checks, and the package-directory Pi loader smoke (`Validator`, `Test`, `Smoke`).
- Repository verification: run `npm run check` and `npm test` separately, retain failures honestly, and add a changeset for published behavior (`Validator`, `Test`, `Review`).

## Plan

- [x] Confirm the unchanged PR head, native Windows baseline evidence, independent checkout, and new fix branch.
- [x] Replace `.cmd` process launches and avoid the Windows-overlong full-suite argument list; verify regression tests and canonical commands without external adapters.
- [x] Fix installed recovery identity on Windows without weakening pre-rename checks, byte verification, journal compatibility, or replacement rejection; verify native rename and interrupted-recovery cases.
- [x] Make the new UI/read-race/symlink tests portable without removing their safety coverage; verify all added ignore-policy tests and legacy wizard tests.
- [x] Add the daemon changeset and retained verification notes; review the complete selected diff for the same failure classes.
- [x] Run native Windows `npm run check`, `npm test`, focused tests, package packs, and RPC/file probes; record results and any unchanged baseline failures.
- [x] Stage only intended files, inspect the index, commit, push, and open the follow-up PR with the correct base and explicit verification limits; draft PR #1998 targets the original feature branch.

## Rollback / Recovery

Keep the existing journal schema and retain unsafe or unmatched transaction evidence. Do not delete user journals or weaken source/configuration review checks. Revert this focused commit to roll back; do not publish or dispatch release workflows.

## Completion Checklist

- [x] The four focused Windows failures are resolved and relevant ownership regressions pass; the focused suite passed on native Windows.
- [x] Canonical Windows build/check/test launchers work without external adapters; build and check passed, and direct compiler/launcher regressions passed.
- [x] `npm run check` passes and the complete `npm test` result is recorded without claiming a failed gate passed.
- [ ] The complete Windows `npm test` gate passes; retain this check open if unrelated baseline failures remain.
- [x] Package/RPC smoke evidence and remaining draft restrictions are included in the PR.
- [x] The follow-up PR exists and its commit and remaining work are reported.

## Verification Results

Native Windows check, test compilation, and the final npm-driven focused run passed: 313 tests passed, none failed, and 30 were skipped. Native NTFS recovery completed after the creation-time transition and removed its journal. Both canonical package packs, the real RPC Settings smoke, and seven file-safety probe groups passed.

The complete canonical Windows run at `4073de5` recorded 23,349 passed, 983 failed, four expected failures, 199 skipped, and ten unhandled errors. Twelve failures came from inherited Windows environment-key aliases in the launcher test fixture; that fixture was corrected and all focused tests were rerun through npm successfully. The complete suite was not rerun after this test-only correction. Its gate remains open; do not describe the complete Windows suite as passing.

A separate Linux CI run was started for the source commit because automatic PR CI targets only `main`: https://github.com/narumiruna/pi-extensions/actions/runs/44923193873. Its final result is not required to reinterpret the failed native Windows gate.

## External Handoff

The maintainer must retain #1995's draft restriction until setup/migration activation and macOS/Windows first-file durability are implemented and verified. This repair does not establish those guarantees. Unrelated full-suite Windows failures remain outside this PR and must not be represented as resolved.
