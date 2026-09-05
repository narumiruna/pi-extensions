# @narumitw/pi-analytics

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
