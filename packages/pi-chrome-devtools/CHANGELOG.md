# @narumitw/pi-chrome-devtools

## 0.52.3

### Patch Changes

- 3effdd1: Use native deferred tool loading only on supported models and eagerly expose configured tools otherwise.

## 0.52.2

### Patch Changes

- 3346683: Publish generated lazy chunks at the JavaScript paths referenced by each extension runtime so deferred menus and implementations load correctly through Pi's Jiti loader.
- Updated dependencies [b9eba3a]
  - @narumitw/pi-tui-kit@0.58.0

## 0.52.1

### Patch Changes

- 30bc076: Load each extension from a generated TypeScript runtime to reduce Jiti package startup work while preserving existing first-use boundaries.

## 0.52.0

### Minor Changes

- eae42b5: Add validated JSON and `/chrome-devtools settings` controls for the DevTools endpoint, auto-launch policy, and browser executable.

  Keep existing `PI_CHROME_DEVTOOLS_*` overrides temporarily, but warn that they are deprecated and should be migrated to `pi-chrome-devtools.json`.

## 0.51.0

### Minor Changes

- 34d3576: Load Chrome DevTools capability tools on demand through a persistent `chrome_devtools_load` tool.

  Treat the saved tool selection as the allowed lazy-load catalog and keep deferred capability metadata out of the stable system prompt prefix.

## 0.50.1

### Patch Changes

- f9a33ed: Require pi-tui-kit 0.51 so disabled menu actions and their explanations render consistently.
- Updated dependencies [736ca9e]
  - @narumitw/pi-tui-kit@0.52.0

## 0.50.0

### Minor Changes

- c434669: Add trusted user and project settings for loading unpacked Chrome extensions into an isolated managed Chrome for Testing or Chromium browser.
- 4d77811: Redesign the Chrome DevTools manager around visible runtime state, staged tool selection with exact review, shallow status/setup/help navigation, and explicit cross-mode behavior.

## 0.49.4

### Patch Changes

- 1b64919: Pass `--do-not-de-elevate` when auto-launching the managed browser so Chrome no longer relaunches de-elevated and exits when Pi runs in an elevated Windows terminal, which the launch watchdog misread as "Auto-launched browser exited before DevTools became available."
