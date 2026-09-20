# @narumitw/pi-tool

## 0.3.2

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.3.1

### Patch Changes

- Updated dependencies [40182e5]
  - @narumitw/pi-tui-kit@0.59.0

## 0.3.0

### Minor Changes

- cf4a5c9: Add a default-off active-tool widget with `/tool` and `pi-tool.json` controls.

### Patch Changes

- 3346683: Publish generated lazy chunks at the JavaScript paths referenced by each extension runtime so deferred menus and implementations load correctly through Pi's Jiti loader.
- Updated dependencies [b9eba3a]
  - @narumitw/pi-tui-kit@0.58.0

## 0.2.3

### Patch Changes

- dc4f90e: Load each extension from a generated source-mapped Jiti runtime while preserving first-use feature boundaries.

## 0.2.2

### Patch Changes

- 17426ab: Use Pi TUI Kit's standard browse screen for searchable tool details while preserving exact schema formatting and command behavior.

## 0.2.1

### Patch Changes

- c3ce1c5: Preserve nested parameter-schema indentation in TUI and RPC tool details.
- Updated dependencies [4a0358b]
- Updated dependencies [93b507b]
  - @narumitw/pi-tui-kit@0.53.0

## 0.2.0

### Minor Changes

- 6a03229: Add a read-only `/tool` catalog for browsing configured tools, their exposed metadata, and effective active prompt snippets.
