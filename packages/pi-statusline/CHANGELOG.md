# @narumitw/pi-statusline

## 0.50.2

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.50.1

### Patch Changes

- 67a3049: Adapt provider, transcript, usage, deferred-tool, and telemetry behavior to Pi's current runtime contracts, including accurate cache-warming accounting and exclusion from ordinary generation traces.

## 0.50.0

### Minor Changes

- b87641b: Show when Pi is waiting for blocking extension UI input and restore the underlying activity after the prompt closes.
  
  Expose `waiting`, `$kind`, and `$title` through pi-starship's activity module.

### Patch Changes

- 36a5ad5: Honor Pi's effective terminal capabilities when rendering pull request hyperlinks and RGB footer colors.

## 0.49.15

### Patch Changes

- Updated dependencies [40182e5]
  - @narumitw/pi-tui-kit@0.59.0

## 0.49.14

### Patch Changes

- dc9802e: Keep Ctrl+C available as a hard-cancel input when configurable cancellation bindings are remapped.
- Updated dependencies [78276b0]
- Updated dependencies [dc9802e]
  - @narumitw/pi-tui-kit@0.58.1

## 0.49.13

### Patch Changes

- 3346683: Publish generated lazy chunks at the JavaScript paths referenced by each extension runtime so deferred menus and implementations load correctly through Pi's Jiti loader.
- Updated dependencies [b9eba3a]
  - @narumitw/pi-tui-kit@0.58.0

## 0.49.12

### Patch Changes

- Updated dependencies [6574232]
- Updated dependencies [cddc265]
  - @narumitw/pi-tui-kit@0.57.0

## 0.49.11

### Patch Changes

- e7ae16e: Load the extension from a generated split TypeScript runtime to reduce Jiti package startup work while preserving the lazy command boundary.

## 0.49.10

### Patch Changes

- 5f0ccd3: Load lightweight Pi TUI Kit helpers without evaluating the full menu runtime during extension startup.

## 0.49.9

### Patch Changes

- Updated dependencies [8bead31]
  - @narumitw/pi-tui-kit@0.56.0

## 0.49.8

### Patch Changes

- Updated dependencies [3176172]
  - @narumitw/pi-tui-kit@0.55.0

## 0.49.7

### Patch Changes

- d26be16: Reuse Pi TUI Kit's display-only terminal sanitizer for footer model, symbol, and path text.

## 0.49.6

### Patch Changes

- 247083f: Use Pi TUI Kit's published live-choice interaction for palette previews while preserving statusline-owned settings, rollback, and footer updates.
- Updated dependencies [4a0358b]
- Updated dependencies [93b507b]
  - @narumitw/pi-tui-kit@0.53.0
