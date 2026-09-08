# @narumitw/pi-sync

## 0.50.2

### Patch Changes

- f6f26ff: Reserve persistent sync widgets and RPC warnings for review conditions. Show ordinary one-sided changes through status, keep setup and empty-remote initialization guidance in the manager, and preserve observations and transfer safety checks.

## 0.50.1

### Patch Changes

- 0f319d2: Add a themed horizontal separator above the sync attention widget to match other widgets above the editor.

## 0.50.0

### Minor Changes

- f566ede: Replace automatic startup transfers with a cancellable background check in TUI and RPC. Pi no longer waits for remote storage or opens startup conflict dialogs; review differences through `/sync` before transferring. The existing `sync.automatic` setting now checks only at startup, while its sessions-enabled automatic shutdown push remains unchanged. Print and JSON modes skip startup checks.
  
  Keep local recovery ahead of user operations, give foreground commands priority, and drain Git cache cleanup before releasing sync locks. Startup observations are advisory and revalidated before manual operations. Cancelled or pre-commit failed reviews retain valid hints; successful fresh reviews clear superseded content-list mismatch hints. Setup summaries disclose conditional shutdown pushes, and recovery help remains available when state roots need repair.

### Patch Changes

- 64b207b: Replace the initial setup purpose menu with direct name input, examples, and a brief explanation of suggested storage paths and separate sync choices. Blank names use `default`. Validate names and suggested backend locations before collecting connection details, and allow invalid names to be corrected immediately.
- 41eaa76: Simplify initial setup to one name across storage backends. Show input examples, explanations, and blank-to-accept defaults directly in Pi's dialogs without treating example endpoints or credentials as defaults. Default all new storage paths to the repository, WebDAV collection, or bucket root, without literal dot prefixes or changes to existing settings. New Git destinations use main, with existing branch safety checks preserved. Require a different path or Git branch before reviewing an additional setup when its chosen location is already configured. Preserve valid literal angle brackets in WebDAV input and edit defaults.
- 7af24f8: Keep initial R2/S3 storage paths identical in the setup review, saved settings, and resolved backend configuration. Setup names are independent of the default root path, including names with trailing slashes.
- f212568: Resolve the Git cache root to an absolute path so snapshot publication works when the cache path is relative and payload hashing changes the subprocess working directory.
- 12998a9: Simplify the setup-name prompt and distinguish its guidance with the theme's muted color.
- fdca695: Make setup choices explicit, retry invalid inputs, and show complete scrollable destination reviews. Clarify connection/setup menus and local save boundaries, retain drafts after recoverable save failures, and add actionable errors with bounded read-only S3 diagnostics.

## 0.49.15

### Patch Changes

- ec874c3: Add a global Settings option to skip push secret scanning while keeping the safe default and doctor diagnostics.

## 0.49.14

### Patch Changes

- Updated dependencies [40182e5]
  - @narumitw/pi-tui-kit@0.59.0

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
