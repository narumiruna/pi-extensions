## Goal

Move `pi-wait-what` out of the active workspace into `extensions/deprecated/`, remove active-package tooling and documentation references, and retain the package for reference.

## Plan

- [x] Move the tracked package files to `extensions/deprecated/pi-wait-what` and mark its README as deprecated; verified the old active path is absent and the deprecated package contains its source, test, metadata, README, and license.
- [x] Remove `wait-what` from active root documentation and package/Just tooling, while listing it with deprecated packages; verified with repository-wide `rg` checks.
- [x] Regenerate workspace metadata and run the repository checks; `package-lock.json` has no `pi-wait-what` workspace entry and `npm run check` passes with 15 active packages and 290 tests.

## Completion Checklist

- [x] `pi-wait-what` exists only under `extensions/deprecated/`, verified with `find` and `git status`.
- [x] Active workspace commands and README package listings no longer advertise `pi-wait-what`, verified with `rg`.
- [x] Repository integrity is verified by `npm run check` (Biome, boundaries, 15 workspace typechecks, and 290 passing tests).
