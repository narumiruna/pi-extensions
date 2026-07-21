## Goal

Deprecate `@narumitw/pi-codex-accounts` and `@narumitw/pi-codex-usage` in this repository in favor of `@narumitw/pi-accounts` and `@narumitw/pi-usage`, preserving their source under `deprecated/` while excluding them from active workspace checks, version bumps, and publishing.

## Context

Both predecessor packages already emit migration warnings after their successors completed a soak period. Before this change, they remained active production workspaces. The npm registry still has no deprecation metadata because its write operation requires a current OTP; that external release action is separate from this repository change.

## Non-Goals

- Delete predecessor source or published npm versions.
- Change successor runtime behavior or legacy data migration.
- Change npm registry metadata as part of this repository change.

## Plan

- [x] Move both predecessor package trees from `extensions/` to `deprecated/`, update their package metadata and README paths/notices, and preserve implementation files unchanged; Git reports all 21 files as renames, with every source and test file matching `HEAD` byte-for-byte.
- [x] Remove predecessor pack/try/install/publish recipes and active root README listings, then update successor migration guidance and the deprecated-package list; targeted `rg` and `just --list` find no active recipes or paths, and a temporary committed-tree run of `list-publish-workspaces.mjs --all` excludes both packages.
- [x] Regenerate `package-lock.json` so neither predecessor is an npm workspace or linked root dependency; the lockfile contains no predecessor references, `npm pkg get name --workspaces` lists only the successors, and shared-version discovery excludes both predecessors.
- [x] Run the CI-equivalent repository gate and audit the final diff; the post-rebase `npm run check` passes all 1,015 tests, and `git diff --check` passes.
- [x] Not applicable to the repository change: npm rejected both external deprecation attempts with `EOTP`, and `npm view` confirms no metadata was applied; record the OTP-protected registry mutation as a release follow-up.

## Risks

- Moving the packages without regenerating the lockfile could leave stale workspace links or dependencies.
- Stale active paths in docs or recipes could continue advertising unsupported local workflows.

## Completion Checklist

- [x] Both predecessor trees exist only under `deprecated/`, with archived metadata and migration notices verified by file inspection and repository searches.
- [x] Active workspace, version-bump, test, and publish discovery exclude both packages, verified by repository commands.
- [x] Root and successor documentation direct users to `pi-accounts` and `pi-usage`, verified by targeted searches and link/path inspection.
- [x] Repository integrity is verified by the post-rebase `npm run check` (1,015 passing tests) and `git diff --check`.
- [x] Not applicable to this repository change: `npm view` verifies registry metadata remains unchanged, and the OTP-protected mutation is documented as a release follow-up.
