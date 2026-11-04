# @narumitw/pi-analytics

## 0.50.0

### Minor Changes

- e29a6a8: Retain optional provider-reported response models separately from requested model IDs and show their call counts in Response cycles. Keep historical records readable without migration and sanitize model IDs only for display. Missing metadata is not inferred; token and cost reporting remain out of scope.

### Patch Changes

- e484010: Include the existing package-root CHANGELOG.md in extension tarballs so Pi can show native update notices. Keep Changesets version headings and Pi's first-observation and collapseChangelog behavior unchanged.
- Updated dependencies [54f2700]
- Updated dependencies [6c76ef1]
  - @narumitw/pi-tui-kit@0.69.0

## 0.49.11

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.49.10

### Patch Changes

- 67a3049: Adapt provider, transcript, usage, deferred-tool, and telemetry behavior to Pi's current runtime contracts, including accurate cache-warming accounting and exclusion from ordinary generation traces.

## 0.49.9

### Patch Changes

- bd00d53: Render standard horizontal frames around the remaining extension menus.

## 0.49.8

### Patch Changes

- 5333554: Promote the extensions to the stable lifecycle and remove their experimental warnings.
  
  Pi Fleet no longer asks for separate experimental consent before its existing launch and join confirmations.

## 0.49.7

### Patch Changes

- 30bc076: Load each extension from a generated TypeScript runtime to reduce Jiti package startup work while preserving existing first-use boundaries.

## 0.49.6

### Patch Changes

- 3344477: Use Pi TUI Kit's published standalone confirmation for analytics deletion so Back remains side-effect free, TUI Ctrl+C closes the dashboard, and stale or failed confirmation cannot clear data.

## 0.49.5

### Patch Changes

- 4a9c94b: Preserve analytics write timeout errors when Node wraps aborted filesystem operations.
- Updated dependencies [2d79365]
  - @narumitw/pi-tui-kit@0.50.0

## 0.49.4

### Patch Changes

- d7b1c3f: Allow local analytics writes more time to complete during transient filesystem stalls.
