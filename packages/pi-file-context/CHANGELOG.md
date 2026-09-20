# @narumitw/pi-file-context

## 0.54.3

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.54.2

### Patch Changes

- Updated dependencies [40182e5]
  - @narumitw/pi-tui-kit@0.59.0

## 0.54.1

### Patch Changes

- Updated dependencies [b9eba3a]
  - @narumitw/pi-tui-kit@0.58.0

## 0.54.0

### Minor Changes

- 64480f8: Promote the extension to stable, include it in root Git installations, and remove its experimental startup warning.

## 0.53.3

### Patch Changes

- 1c7d26c: Use Ctrl+Shift+X as the default browser shortcut and configure it safely from the File Context Settings menu.
- 01457d0: Browse discovered project folders hierarchically while keeping global file and content search.
- e2a2055: Open current worktree files in Pi's configured external editor from File Preview and show effective preview shortcuts.
- Updated dependencies [8540d0f]
  - @narumitw/pi-tui-kit@0.57.1

## 0.53.2

### Patch Changes

- 30bc076: Load each extension from a generated TypeScript runtime to reduce Jiti package startup work while preserving existing first-use boundaries.

## 0.53.1

### Patch Changes

- bf127d8: Prioritize shallow project files before deeper files during bounded File Context discovery.

## 0.53.0

### Minor Changes

- 047f420: Make context selection a coherent next-prompt workflow with add-and-continue browsing, exact review before removal, visible capacity, adaptive preview help, and cancellable scanning from every explorer route.

## 0.52.0

### Minor Changes

- e68ad9e: Redesign `/file-context` as an Add, Remove, and Help menu with exact quote previews, repeated removal, cancellable project scanning, and compatible direct `browse` and `remove` routes.

## 0.51.1

### Patch Changes

- 9a086ce: Change the default File Context shortcut from terminal-dependent `Ctrl+Alt+F` to `F8` while preserving explicit custom shortcut settings and `/file-context`.

## 0.51.0

### Minor Changes

- e30d267: Replace the immediate `@` screen takeover with a configurable File Context shortcut that defaults to `Ctrl+Alt+F`, preserves Pi's native editor, and can be disabled in user settings.

## 0.50.0

### Minor Changes

- f3f5297: Add cancellable cwd content search with highlighted result cards, case and fuzzy toggles, and matched-line preview navigation.
