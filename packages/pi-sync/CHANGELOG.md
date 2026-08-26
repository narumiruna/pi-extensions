# @narumitw/pi-sync

## 0.49.13

### Patch Changes

- dc9802e: Keep Ctrl+C available as a hard-cancel input when configurable cancellation bindings are remapped.
- Updated dependencies [78276b0]
- Updated dependencies [dc9802e]
  - @narumitw/pi-tui-kit@0.58.1

## 0.49.12

### Patch Changes

- 806eada: Reduce extension startup time by letting generated TypeScript chunks reference their emitted `.ts` files directly.

## 0.49.11

### Patch Changes

- 9224800: Load the extension from a generated split TypeScript runtime to reduce Jiti startup work while preserving existing first-use boundaries.

## 0.49.10

### Patch Changes

- e3375f0: Avoid migration-lock contention during normal state access and safely share legacy migration protection across overlapping work in one Pi process.

## 0.49.9

### Patch Changes

- 38a36bb: Make interrupted-operation recovery immediately actionable in the sync manager, distinguish live and guarded operations from recoverable locks, confirm local-lock removal, and return directly to normal sync actions after recovery.

## 0.49.8

### Patch Changes

- f75f7e9: Open reviewed synced-content recovery when automatic or interactive TUI sync detects a content-list mismatch, preserve deferred attention in the manager and editor, and keep deterministic and non-TUI routes non-blocking.

## 0.49.7

### Patch Changes

- 549e626: Resolve differing local and remote synced-content lists inline with reviewed adoption, explicit continuation, and the existing safe force-push path.

## 0.49.6

### Patch Changes

- fa9c938: Reduce idle startup imports by loading Goal presentation, Chat networking and UI, and Sync operation-specific modules only when their routes require them.

## 0.49.5

### Patch Changes

- 8289ba9: Move operational state from `.pisync` to `pi-sync` with an explicit guarded migration and fail-closed path handling.
- Updated dependencies [736ca9e]
  - @narumitw/pi-tui-kit@0.52.0

## 0.49.4

### Patch Changes

- 6432b4d: Make included-content intent portable across snapshots, add reviewed remote-policy adoption, pause sync on explicit policy divergence, and allow safe custom paths that exist only remotely.
