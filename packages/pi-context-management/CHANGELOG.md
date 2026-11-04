# @narumitw/pi-context-management

## 0.1.2

### Patch Changes

- e484010: Include the existing package-root CHANGELOG.md in extension tarballs so Pi can show native update notices. Keep Changesets version headings and Pi's first-observation and collapseChangelog behavior unchanged.
- 5120d4d: Preserve TypeBox enum inference for direct imports and Pi's extension loader without changing provider-visible schemas or validation rules. Import Notes schemas from TypeBox, declare its host-provided peer, and complete Worktree's command result contract for the updated Pi APIs.
- Updated dependencies [54f2700]
- Updated dependencies [6c76ef1]
  - @narumitw/pi-tui-kit@0.69.0

## 0.1.1

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.1.0

### Minor Changes

- f3e18ce: Add an opt-in standalone extension for summary-free context rollover, bounded history recall, and branch-local notes.

### Patch Changes

- 827ca96: Bound recalled compaction details as one operation, avoid rescanning history before the first page, and restore tools after a successful lineage retry.
