# @narumitw/pi-lsp

## 0.49.7

### Patch Changes

- 756e1e2: Cancel and drain session-owned LSP calls during shutdown and reload, including partially initialized servers. Keep resource cleanup independent of status UI failures, preserve original operation errors, and prevent cancelled continuations from writing fixes or starting another diagnostics route. Share client lifetime handling between diagnostics and fixes.

## 0.49.6

### Patch Changes

- c23e604: Key published diagnostics by a canonical file path so equivalent URI encodings are matched, and wait for each LSP process to exit before completing shutdown.

## 0.49.5

### Patch Changes

- 30bc076: Load each extension from a generated TypeScript runtime to reduce Jiti package startup work while preserving existing first-use boundaries.

## 0.49.4

### Patch Changes

- 9b96a71: Use Pi's host-provided coding-agent and TypeBox runtimes instead of installing duplicate copies.
