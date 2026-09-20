# Share pi-accounts private-file reads

## Goal

Use one package-internal implementation for security-sensitive account-file reads without changing storage, migration, permissions, errors, or credential handling.

## Context

`packages/pi-accounts/src/account-store.ts` and `packages/pi-accounts/src/storage.ts` independently perform the same sequence: `lstat`, reject symlinks and non-files, open with `O_NOFOLLOW`, validate the descriptor with `fstat`, repair permissions to `0600`, read through the descriptor, and close it.

Storage reads use one copy, while legacy migration validation and permission enforcement use the other. The duplication can diverge on a credential-protection invariant.

Applicable rules:

- Every locked credential read **MUST** reject symlinks, validate the opened descriptor, repair permissions to `0600`, and close the descriptor.
- Migration behavior, source retention, canonical precedence, and atomic publication **MUST** remain unchanged.
- Account settings and storage formats are out of scope; `docs/extension-settings.md` requires no settings changes.

## Non-Goals

- Do not change account schemas, migration policy, lock behavior, path precedence, or storage APIs.
- Do not combine unrelated existence checks unless exact semantics and ownership are independently proven.
- Do not introduce a generic filesystem utility package.

## Risks

- Reordering filesystem operations could weaken symlink protection or change observable errors.
- Exporting the helper from a public module could accidentally expand the package API.
- Refactoring migration and storage together could obscure their distinct policy responsibilities.

## Plan

- [ ] Record baseline behavior with `packages/pi-accounts/test/accounts-storage.test.ts`; verify ordinary reads, symlink rejection, permission repair, legacy migration, concurrent migration, interrupted migration, and canonical precedence pass.
- [ ] Compare both reader implementations operation by operation and record any difference in imported error guards or caller expectations before editing.
- [ ] Add one focused package-internal private-file module containing the exact regular-file read sequence and existing error text; keep it outside public exports.
- [ ] Replace the duplicate readers in `account-store.ts` and `storage.ts` with imports from the internal module while leaving migration and storage control flow unchanged.
- [ ] Add or refine focused tests only where needed to prove descriptor validation, `O_NOFOLLOW`, `0600` repair on every read, descriptor closure after failure, and unchanged symlink target contents.
- [ ] Audit migration and storage callers together for path precedence, lock scope, failure recovery, stale temporary files, and source retention; verify the extraction did not alter those policies.
- [ ] Run `npx vitest run packages/pi-accounts/test/accounts-storage.test.ts packages/pi-accounts/test/accounts.test.ts packages/pi-accounts/test/build-runtime.test.ts`.
- [ ] Run `npm --workspace @narumitw/pi-accounts run build --if-present`, `npm run check`, and plain `npm test`; verify all gates pass without tracked generated changes.
- [ ] Smoke the package with `pi --no-extensions --no-skills -e ./packages/pi-accounts --list-models` and record security-test and loader evidence in the handoff.

## Rollback / Recovery

No credential contents or storage schema are migrated. If operation ordering, errors, permissions, or migration behavior differs, restore both callers' previous local implementation together with the helper removal. Never recover by weakening symlink or descriptor checks.

## Completion Checklist

- [ ] One package-internal reader owns the complete private regular-file invariant.
- [ ] Storage and migration retain distinct policy control flow.
- [ ] Symlink rejection, descriptor validation, `0600` repair, error text, and cleanup match the baseline.
- [ ] Existing credential and migration tests pass.
- [ ] Package build, root checks, tests, and Pi loader smoke pass.
- [ ] No public API, settings, schema, or unrelated files changed.
