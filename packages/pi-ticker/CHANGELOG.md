# @narumitw/pi-ticker

## 0.1.7

### Patch Changes

- 54f2700: Preserve fullscreen viewport capture through custom list wrappers so default and configured paging keys reach the focused list. Keep native transcript search, unrelated overlays, free-text modes, paste, and hard cancellation unchanged. Filter Kit key hints according to each screen's capture policy.
  
  Update Recall and File Context to the current Kit dependency range. The selected consumer releases require the fixed Kit patch through Changesets dependency-floor updates.
- e484010: Include the existing package-root CHANGELOG.md in extension tarballs so Pi can show native update notices. Keep Changesets version headings and Pi's first-observation and collapseChangelog behavior unchanged.
- Updated dependencies [54f2700]
- Updated dependencies [6c76ef1]
  - @narumitw/pi-tui-kit@0.69.0

## 0.1.6

### Patch Changes

- 9d3e0d7: Unreference passive refresh, debounce, expiry, and background startup timers so they do not keep the host process alive when other work has stopped. Keep normal cancellation and resource cleanup unchanged.
- Updated dependencies [9d3e0d7]
  - @narumitw/pi-tui-kit@0.68.1

## 0.1.5

### Patch Changes

- Updated dependencies [a21d39b]
- Updated dependencies [f68aa54]
- Updated dependencies [b062d21]
  - @narumitw/pi-tui-kit@0.68.0

## 0.1.4

### Patch Changes

- 209ff7a: Use Pi TUI Kit's existing `EditorStatusWidget` for passive editor widgets. Share the muted separator and terminal-width bounds while retaining extension-owned content, refresh scheduling, cleanup, and RPC behavior. Sanitize untrusted display values before styling and wrapping without changing raw payloads.

## 0.1.3

### Patch Changes

- Updated dependencies [57eeae7]
  - @narumitw/pi-tui-kit@0.67.0

## 0.1.2

### Patch Changes

- 168248c: Reuse published TUI Kit frame metadata, masked input, configured-key syntax, and interaction ownership while retaining extension-owned settings and cancellation policy. Keep malformed Ticker key strings from suppressing valid reorder shortcuts, and drain Usage settings saves after cancellation.

## 0.1.1

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.1.0

### Minor Changes

- ffa69a7: Add the Ticker extension for configurable Yahoo Finance quotes above Pi's editor.
