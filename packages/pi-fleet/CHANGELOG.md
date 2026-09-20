# @narumitw/pi-fleet

## 0.3.7

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.3.6

### Patch Changes

- 5333554: Promote the extensions to the stable lifecycle and remove their experimental warnings.
  
  Pi Fleet no longer asks for separate experimental consent before its existing launch and join confirmations.

## 0.3.5

### Patch Changes

- Updated dependencies [40182e5]
  - @narumitw/pi-tui-kit@0.59.0

## 0.3.4

### Patch Changes

- 3346683: Publish generated lazy chunks at the JavaScript paths referenced by each extension runtime so deferred menus and implementations load correctly through Pi's Jiti loader.
- Updated dependencies [b9eba3a]
  - @narumitw/pi-tui-kit@0.58.0

## 0.3.3

### Patch Changes

- Updated dependencies [6574232]
- Updated dependencies [cddc265]
  - @narumitw/pi-tui-kit@0.57.0

## 0.3.2

### Patch Changes

- 30bc076: Load each extension from a generated TypeScript runtime to reduce Jiti package startup work while preserving existing first-use boundaries.

## 0.3.1

### Patch Changes

- Updated dependencies [8bead31]
  - @narumitw/pi-tui-kit@0.56.0

## 0.3.0

### Minor Changes

- 984b554: Select the current tmux, Zellij, or Ghostty context automatically by default while keeping pinned and explicit backend choices strict.

### Patch Changes

- Updated dependencies [3176172]
  - @narumitw/pi-tui-kit@0.55.0

## 0.2.0

### Minor Changes

- ea5423c: Default session spawning to tmux 3.2 or newer, preserve Ghostty and add Zellij 0.44 or newer as configurable backends, and add persistent launch confirmation settings shared by menu and tool launches.

## 0.1.0

### Minor Changes

- de82445: Add an experimental extension that launches authenticated local Pi sessions in Ghostty splits with parent-only kickoff capabilities and supports endpoint-bound, deadline-bounded version-2 Unix-socket messaging.
