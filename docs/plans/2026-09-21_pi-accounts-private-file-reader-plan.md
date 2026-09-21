# Share pi-accounts private-file reads

## Goal

Use one package-internal implementation for security-sensitive account-file reads that enforces path identity before permission repair or reading. Preserve storage, migration, permissions, and existing errors except for the intentional rejection of files replaced between `lstat` and `open`.

## Context

`packages/pi-accounts/src/account-store.ts` and `packages/pi-accounts/src/storage.ts` independently perform the same sequence: `lstat`, reject symlinks and non-files, open with `O_NOFOLLOW`, validate the descriptor with `fstat`, repair permissions to `0600`, read through the descriptor, and close it.

Storage reads use one copy, while legacy migration validation and permission enforcement use the other. Both currently check only the descriptor's file type, not whether its device and inode match the pre-open `lstat` result. `O_NOFOLLOW` rejects symlinks but permits regular-file replacements, so the current sequence does not satisfy the path-identity invariant in `packages/pi-accounts/AGENTS.md`.

Applicable rules:

- Every locked credential read **MUST** reject symlinks and non-files and compare the pre-open `lstat` device/inode pair with the opened descriptor's `fstat` pair before `fchmod` or reading; either mismatch must fail closed without reading or changing the replacement file.
- The shared reader **MUST** apply the same identity check to migration validation and permission enforcement, repair permissions to `0600` only after validation, and close every opened descriptor on success or failure.
- Migration behavior, source retention, canonical precedence, and atomic publication **MUST** remain unchanged.
- Account settings and storage formats are out of scope; `docs/extension-settings.md` requires no settings changes.

## Non-Goals

- Do not change account schemas, migration policy, lock behavior, path precedence, or storage APIs.
- Do not combine unrelated existence checks unless exact semantics and ownership are independently proven.
- Do not introduce a generic filesystem utility package.

## Risks

- Reordering filesystem operations could weaken symlink protection; checking identity after `fchmod` or reading would already affect or expose the replacement file.
- Identity mismatch rejection intentionally changes the unsafe baseline; tests must distinguish that correction from unrelated error or migration changes.
- Exporting the helper from a public module could accidentally expand the package API.
- Refactoring migration and storage together could obscure their distinct policy responsibilities.

## Plan

- [ ] Record baseline behavior with `packages/pi-accounts/test/accounts-storage.test.ts`; verify ordinary reads, symlink rejection, permission repair, legacy migration, concurrent migration, interrupted migration, and canonical precedence pass.
- [ ] Compare both reader implementations operation by operation, record the missing identity check and any caller differences, and reproduce a regular-file replacement between `lstat` and `open` using a deterministic filesystem hook rather than a timing-dependent race.
- [ ] Add one focused package-internal private-file module that retains the pre-open `lstat` result, opens with `O_NOFOLLOW`, checks the descriptor is a regular file, and rejects unequal `dev` or `ino` values before permission repair or reading; preserve existing errors and add a credential-free identity-mismatch error, keeping the helper outside public exports.
- [ ] Replace the duplicate readers in `account-store.ts` and `storage.ts` with imports from the internal module while leaving migration and storage control flow unchanged except for propagation of identity-mismatch failures.
- [ ] Add deterministic tests for matching identity, inode-only mismatch, and device-only mismatch; include a real regular-file replacement between `lstat` and `open`, and assert mismatches never call `fchmod` or read through the descriptor, leave replacement contents and permissions unchanged, and close the descriptor.
- [ ] Cover identity rejection through locked storage reads and migration validation/permission enforcement, including sync and async callers; retain tests for symlink and non-file rejection, `O_NOFOLLOW`, `0600` repair on valid reads, and descriptor closure after validation, chmod, or read failures.
- [ ] Audit migration and storage callers together for path precedence, lock scope, failure recovery, stale temporary files, and source retention; verify the extraction did not alter those policies.
- [ ] Add a patch Changeset for `@narumitw/pi-accounts` documenting the intentional rejection of replaced files; the implementation changes published behavior, not just code organization.
- [ ] Run the new private-file tests and `npx vitest run packages/pi-accounts/test/accounts-storage.test.ts packages/pi-accounts/test/accounts.test.ts packages/pi-accounts/test/build-runtime.test.ts`.
- [ ] Run `npm --workspace @narumitw/pi-accounts run build --if-present`, `npm run check`, and plain `npm test`; verify all gates pass without tracked generated changes.
- [ ] Smoke the package with `pi --no-extensions --no-skills -e ./packages/pi-accounts --list-models` and record security-test and loader evidence in the handoff.

## Rollback / Recovery

No credential contents or storage schema are migrated. If the extraction causes regressions beyond the intentional identity-mismatch rejection, restore caller-local readers before removing the helper, but retain the device/inode validation and regression tests in both copies. Never recover by restoring the unsafe baseline or weakening symlink, identity, permission, or descriptor-cleanup checks.

## Completion Checklist

- [ ] One package-internal reader owns the complete private regular-file invariant.
- [ ] Storage and migration retain distinct policy control flow.
- [ ] Matching-identity reads retain baseline symlink rejection, descriptor validation, `0600` repair, existing error text, and cleanup.
- [ ] Regular-file replacement and either identity-field mismatch fail before chmod or reading, close the descriptor, and leave the replacement untouched in storage and migration paths.
- [ ] Existing credential/migration tests and deterministic identity-race tests pass, and the patch Changeset records the intentional behavior change.
- [ ] Package build, root checks, tests, and Pi loader smoke pass.
- [ ] No public API, settings, schema, or unrelated files changed.
