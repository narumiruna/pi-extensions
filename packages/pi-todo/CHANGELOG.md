# @narumitw/pi-todo

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
