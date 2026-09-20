# @narumitw/pi-progress

This changelog retains the published `@narumitw/pi-todo` predecessor history below the first `pi-progress` release.

## 0.3.4

### Patch Changes

- fb1a121: Announce the move to `@narumitw/pi-progress` in the package documentation and supported UI modes while keeping the existing todo tool and session behavior unchanged.

## 0.3.3

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.3.2

### Patch Changes

- 67a3049: Adapt provider, transcript, usage, deferred-tool, and telemetry behavior to Pi's current runtime contracts, including accurate cache-warming accounting and exclusion from ordinary generation traces.

## 0.3.1

### Patch Changes

- 3d4054b: Reuse published Kit terminal-document sanitization and editor-status frames for Todo widgets. Preserve control spacing and adaptive row priorities while removing unterminated terminal sequences from display text.
- Updated dependencies [317f7bd]
  - @narumitw/pi-tui-kit@0.61.0

## 0.3.0

### Minor Changes

- b301911: Add adaptive widget layouts, transient completion summaries, actionable validation, read-only display settings, and blocked todos with versioned session migration.

## 0.2.0

### Minor Changes

- 8b98f19: Replace the `update_todo_list` payload and current result details with `{ todos: [{ step, status }] }` while preserving branch restoration from valid version 1 `{ items: [{ text, status }] }` details.

### Patch Changes

- 37a724d: Preserve version 1 restored todo boundaries across reloads and branch navigation.

## 0.1.2

### Patch Changes

- 6dd7b9e: Persist restored todo, subagent guidance, and required-completion context boundaries as validated branch-local session metadata so reloads and tree navigation preserve stable model-visible prefixes.

## 0.1.1

### Patch Changes

- 3c19622: Restore compacted todo and required-subagent state at deterministic summary boundaries, retain each restored message for its summary epoch as later tail evidence supersedes it, and append restored required-run cancellations after stale retained handoffs while keeping request prefixes stable.
  
  Publish mutable subagent catalog and policy guidance through append-only session contracts instead of re-registering provider-visible tools.

## 0.1.0

### Minor Changes

- 71bffd5: Add the Todo Widget extension with branch-aware task lists managed by `update_todo_list`, compaction-aware context fallback, and an above-editor display that wraps long task text to the available width.
