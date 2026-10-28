# @narumitw/pi-herdr

## 0.3.3

### Patch Changes

- a21d39b: Add opt-in editor status presentation helpers for stable snapshot publication, session-local view controls, and bounded whole-snapshot collections. Keep the existing EditorStatusWidget API unchanged.
  
  Retain visible Progress, Subagents, and Herdr widgets during updates. Add bounded summaries, manual view and item controls, and explicit one-shot compaction policies to Progress and Subagents without changing task state or persistent defaults. Preserve Progress completion retention and keep Herdr observation policies local. Keep tree navigation and manual context compaction separate from response-cycle tracking.
- Updated dependencies [a21d39b]
- Updated dependencies [f68aa54]
- Updated dependencies [b062d21]
  - @narumitw/pi-tui-kit@0.68.0

## 0.3.2

### Patch Changes

- 419a94c: Refresh the agent widget from authoritative reads on pane and workspace updates, without replaying stale events or retaining cleared presentation fields. Validate reporting acknowledgements, recover safely from lost events, and drain session-owned reporting during shutdown while leaving native ownership and restore behavior unchanged.
- Updated dependencies [077137a]
- Updated dependencies [9f80b89]
- Updated dependencies [efc474c]
  - @narumitw/pi-tui-kit@0.66.0

## 0.3.1

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.3.0

### Minor Changes

- 78eeac4: Add guarded automatic cleanup guidance for temporary task-owned Herdr panes, with explicit retention and safe fallback behavior.

### Patch Changes

- Updated dependencies [393783f]
- Updated dependencies [845bb04]
  - @narumitw/pi-tui-kit@0.63.0

## 0.2.0

### Minor Changes

- 4b143f4: Add a /herdr menu with a persistent agent-widget toggle, status, and help. Keep the widget enabled by default and lifecycle reporting independent of visibility.

## 0.1.1

### Patch Changes

- f92ea02: Replace the duplicated Herdr operating guide with a thin bootstrap that loads version-matched instructions from `herdr --skill` once per retained context.

## 0.1.0

### Minor Changes

- 3005cd2: Publish bounded Pi model, provider, Thinking level, session, and context-usage metadata to Herdr.
  
  Synchronize the bundled Herdr blocked-agent safety guidance and align widget states with semantic Pi theme roles.
- ee0b28a: Bundle Herdr's Pi agent-state integration with the `herdr` operating skill in one installable package.
  
  Report interactive Pi session and lifecycle state to Herdr with bounded local socket retries and shutdown cancellation.
  
  Show recognized sibling agents from the current Herdr workspace in a terminal-safe, event-driven widget above Pi's editor, with distinct state, renamed agent, pane, and workspace identities.

### Patch Changes

- 071454c: Align the sibling-agent widget's state icons with Herdr's distinct static status symbols.
