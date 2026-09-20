# @narumitw/pi-recall

## 0.50.8

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.50.7

### Patch Changes

- 5333554: Promote the extensions to the stable lifecycle and remove their experimental warnings.
  
  Pi Fleet no longer asks for separate experimental consent before its existing launch and join confirmations.

## 0.50.6

### Patch Changes

- Updated dependencies [40182e5]
  - @narumitw/pi-tui-kit@0.59.0

## 0.50.5

### Patch Changes

- 3346683: Publish generated lazy chunks at the JavaScript paths referenced by each extension runtime so deferred menus and implementations load correctly through Pi's Jiti loader.
- Updated dependencies [b9eba3a]
  - @narumitw/pi-tui-kit@0.58.0

## 0.50.4

### Patch Changes

- Updated dependencies [6574232]
- Updated dependencies [cddc265]
  - @narumitw/pi-tui-kit@0.57.0

## 0.50.3

### Patch Changes

- dc4f90e: Load each extension from a generated source-mapped Jiti runtime while preserving first-use feature boundaries.

## 0.50.2

### Patch Changes

- 5f0ccd3: Load lightweight Pi TUI Kit helpers without evaluating the full menu runtime during extension startup.

## 0.50.1

### Patch Changes

- Updated dependencies [8bead31]
  - @narumitw/pi-tui-kit@0.56.0

## 0.50.0

### Minor Changes

- 64af8e8: Add tree-inspired All, User, and Assistant views to the saved-message TUI, preserve the active view through in-flow navigation and deletion, and require Pi TUI Kit 0.52 or newer for binding-aware hints.

### Patch Changes

- Updated dependencies [3176172]
  - @narumitw/pi-tui-kit@0.55.0
