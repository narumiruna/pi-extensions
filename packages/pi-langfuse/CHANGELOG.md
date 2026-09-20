# @narumitw/pi-langfuse

## 0.51.1

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.51.0

### Minor Changes

- 2e1031d: Add public process-level Langfuse runtime and per-session Pi tracing controller APIs for safely tracing multiple concurrent sessions in one host process.

### Patch Changes

- 67a3049: Adapt provider, transcript, usage, deferred-tool, and telemetry behavior to Pi's current runtime contracts, including accurate cache-warming accounting and exclusion from ordinary generation traces.

## 0.50.6

### Patch Changes

- d365daa: Publish the updated Langfuse tracing and OpenTelemetry runtime dependency ranges.
- Updated dependencies [d365daa]
  - @narumitw/pi-tui-kit@0.63.1

## 0.50.5

### Patch Changes

- Updated dependencies [40182e5]
  - @narumitw/pi-tui-kit@0.59.0

## 0.50.4

### Patch Changes

- 3346683: Publish generated lazy chunks at the JavaScript paths referenced by each extension runtime so deferred menus and implementations load correctly through Pi's Jiti loader.
- Updated dependencies [b9eba3a]
  - @narumitw/pi-tui-kit@0.58.0

## 0.50.3

### Patch Changes

- Updated dependencies [6574232]
- Updated dependencies [cddc265]
  - @narumitw/pi-tui-kit@0.57.0

## 0.50.2

### Patch Changes

- dc4f90e: Load each extension from a generated source-mapped Jiti runtime while preserving first-use feature boundaries.

## 0.50.1

### Patch Changes

- Updated dependencies [8bead31]
  - @narumitw/pi-tui-kit@0.56.0

## 0.50.0

### Minor Changes

- 1086433: Add an optional `userId` setting to `pi-langfuse.json` and stamp it on every observation so Langfuse attributes traces and sessions to a user.

### Patch Changes

- Updated dependencies [3176172]
  - @narumitw/pi-tui-kit@0.55.0

## 0.49.4

### Patch Changes

- 1e630c1: Stamp the Langfuse session ID on every observation and apply session updates so session-level token and cost totals include generations.
- Updated dependencies [11bdf1e]
  - @narumitw/pi-tui-kit@0.54.1
