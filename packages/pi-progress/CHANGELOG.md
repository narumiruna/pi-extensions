# @narumitw/pi-progress

This changelog retains the published `@narumitw/pi-todo` predecessor history below the first `pi-progress` release.

## 0.7.0

### Minor Changes

- a21d39b: Add opt-in editor status presentation helpers for stable snapshot publication, session-local view controls, and bounded whole-snapshot collections. Keep the existing EditorStatusWidget API unchanged.
  
  Retain visible Progress, Subagents, and Herdr widgets during updates. Add bounded summaries, manual view and item controls, and explicit one-shot compaction policies to Progress and Subagents without changing task state or persistent defaults. Preserve Progress completion retention and keep Herdr observation policies local. Keep tree navigation and manual context compaction separate from response-cycle tracking.

### Patch Changes

- Updated dependencies [a21d39b]
- Updated dependencies [f68aa54]
- Updated dependencies [b062d21]
  - @narumitw/pi-tui-kit@0.68.0

## 0.6.4

### Patch Changes

- Updated dependencies [57eeae7]
  - @narumitw/pi-tui-kit@0.67.0

## 0.6.3

### Patch Changes

- 168248c: Reuse published TUI Kit frame metadata, masked input, configured-key syntax, and interaction ownership while retaining extension-owned settings and cancellation policy. Keep malformed Ticker key strings from suppressing valid reorder shortcuts, and drain Usage settings saves after cancellation.

## 0.6.2

### Patch Changes

- 9f80b89: Reuse published Kit interaction ownership for native Progress and Subagents settings while preserving ordered saves, rollback, and durable-save recovery after the screen closes.
  
  Share passive widget framing in Subagents, Tool, Plan Mode, and Cache Hit Monitor. Keep domain rendering and lifecycle ownership local, bound narrow and invalid widths, and retain lazy loading of Kit menus and other interactive APIs.
- Updated dependencies [077137a]
- Updated dependencies [9f80b89]
- Updated dependencies [efc474c]
  - @narumitw/pi-tui-kit@0.66.0

## 0.6.1

### Patch Changes

- e39afe6: Keep a fully completed progress widget hidden when a session starts again. Startup, resume, fork, and reload no longer replay the completion summary or reopen that snapshot; saved progress, tree navigation, and later incomplete updates are unchanged.

## 0.6.0

### Minor Changes

- 70cfac5: Flatten the five display settings in `pi-progress.json`. Existing nested `widget` settings remain readable, with top-level fields taking precedence.
  
  Stop reading `pi-todo.json`. Users who rely on that file must copy their preferences into `pi-progress.json`; the extension leaves the old file unchanged.
- f3cfb92: Add a menu-first `/progress` command with Settings, Status, Help, and Clear widget. Keep `/progress clear` and `/progress settings` as direct routes; the latter edits the five display preferences in the same TUI screen. Successful saves apply immediately, preserve unknown JSON fields, and use ordered atomic publication. Invalid files and failed saves leave the previous settings unchanged. RPC reports the settings file path for manual editing. Frame the settings screen with shared full-width horizontal rules and height-aware active-row retention. Place Clear widget first in the main menu. Support mouse input in the menu and Settings. Replace the long item-limit selector with a validated number input; a blank field removes the limit. Apply completed saves to the active session after screen closure and preserve existing POSIX permissions under a stricter umask.
- 25955d7: Add `/progress clear` to dismiss the current widget without changing saved progress or conversation history.

## 0.5.1

### Patch Changes

- b7a6ac4: Simplify progress guidance to report completed, current, and upcoming work on meaningful changes without requiring tool calls before work or replies. Reserve empty snapshots for intentional clearing rather than requiring completed progress to be cleared.
- Updated dependencies [6a2f900]
- Updated dependencies [80eef72]
  - @narumitw/pi-tui-kit@0.65.5

## 0.5.0

### Minor Changes

- c61e1e0: Simplify progress steps to `{ text, status }`, retaining blocked status and asking the model to describe its unblock condition in text. This is a breaking result/schema change for consumers of the separate reason field; use a minor bump for this pre-1.0 package.
  
  Write version 5 state, strictly decode historical versions, and losslessly merge valid blocked reasons into text. Keep legacy tool-call tolerance and established compaction boundaries. Raise the text limit to 503 characters to accommodate the old 300-character text, separator, and 200-character reason; older packages do not restore version 5 results.

### Patch Changes

- 09dac97: Publish progress and completion widgets as string lines in RPC mode instead of ignored component factories.
- 1258c73: Render progress widgets in UI-capable RPC hosts such as Pi Web while keeping print and JSON modes headless.

## 0.4.2

### Patch Changes

- fb35c02: Express progress steps as a discriminated union in the tool schema so only blocked steps expose and require a reason. Preserve redundant-reason input normalization and recognize normalized call/result pairs during compaction without changing stored state or historical result validation.
- Updated dependencies [178e2e4]
  - @narumitw/pi-tui-kit@0.65.3

## 0.4.1

### Patch Changes

- e706fc5: Ignore redundant `reason` fields on non-blocked `update_progress` steps before strict validation so explanatory model output does not cause avoidable tool retries.

## 0.4.0

### Minor Changes

- ef49945: Replace the Todo package and tool with `@narumitw/pi-progress` and the canonical `update_progress` `{ steps: [{ text, status, reason? }] }` contract while preserving valid historical session state, compaction boundaries, and read-only legacy settings fallback.

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
