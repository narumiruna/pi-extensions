# @narumitw/pi-context-management

## 0.1.1

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.1.0

### Minor Changes

- f3e18ce: Add an opt-in standalone extension for summary-free context rollover, bounded history recall, and branch-local notes.

### Patch Changes

- 827ca96: Bound recalled compaction details as one operation, avoid rescanning history before the first page, and restore tools after a successful lineage retry.
