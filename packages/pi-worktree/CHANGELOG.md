# @narumitw/pi-worktree

## 0.51.10

### Patch Changes

- Updated dependencies [cf7b63d]
  - @narumitw/pi-tui-kit@0.70.0

## 0.51.9

### Patch Changes

- e484010: Include the existing package-root CHANGELOG.md in extension tarballs so Pi can show native update notices. Keep Changesets version headings and Pi's first-observation and collapseChangelog behavior unchanged.
- 5120d4d: Preserve TypeBox enum inference for direct imports and Pi's extension loader without changing provider-visible schemas or validation rules. Import Notes schemas from TypeBox, declare its host-provided peer, and complete Worktree's command result contract for the updated Pi APIs.
- 0339567: Bound Git command output by operation and report output overflow separately from timeouts. Reject incomplete results before parsing or sparse-checkout fallbacks, and do not use them to approve removal, pruning, or successful creation.
- Updated dependencies [54f2700]
- Updated dependencies [6c76ef1]
  - @narumitw/pi-tui-kit@0.69.0

## 0.51.8

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.51.7

### Patch Changes

- 7f56adf: Normalize the cwd comparison in `writeTargetSession` so `/worktree` workspace switching works on Windows, where Git reports forward-slash paths but session headers store backslashes.

## 0.51.6

### Patch Changes

- Updated dependencies [40182e5]
  - @narumitw/pi-tui-kit@0.59.0

## 0.51.5

### Patch Changes

- Updated dependencies [b9eba3a]
  - @narumitw/pi-tui-kit@0.58.0

## 0.51.4

### Patch Changes

- Updated dependencies [6574232]
- Updated dependencies [cddc265]
  - @narumitw/pi-tui-kit@0.57.0

## 0.51.3

### Patch Changes

- dc4f90e: Load each extension from a generated source-mapped Jiti runtime while preserving first-use feature boundaries.

## 0.51.2

### Patch Changes

- Updated dependencies [8bead31]
  - @narumitw/pi-tui-kit@0.56.0

## 0.51.1

### Patch Changes

- Updated dependencies [3176172]
  - @narumitw/pi-tui-kit@0.55.0

## 0.51.0

### Minor Changes

- 5fd422d: Add local fuzzy search to worktree identity selectors.

## 0.50.0

### Minor Changes

- 0ad0f9f: Add an on-demand worktree status browser and exact commit provenance checks to the Add flow.
