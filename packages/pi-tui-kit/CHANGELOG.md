# @narumitw/pi-tui-kit

## 0.58.1

### Patch Changes

- 78276b0: Keep standard menu frames within the live terminal height while preserving actionable rows and exit hints.
- dc9802e: Keep Ctrl+C available as a hard-cancel input when configurable cancellation bindings are remapped.

## 0.58.0

### Minor Changes

- b9eba3a: Add a width-safe `HorizontalRule` component with inset, labeled, aligned, sanitized, and callback-styled rendering.
  Use themed top and bottom rules consistently across every standard TUI screen.

## 0.57.1

### Patch Changes

- 8540d0f: Simplify single-question TUI questionnaires with a plain header and immediate answer submission while retaining tabbed Review for multiple questions.

## 0.57.0

### Minor Changes

- 6574232: Add a generic lifecycle-safe questionnaire runner for TUI and RPC interactions.

### Patch Changes

- cddc265: Keep questionnaire hints visible at narrow widths and omit conflicting additive page keys.

## 0.56.1

### Patch Changes

- f47364f: Defer syntax highlighter initialization until a code review first requests it.

## 0.56.0

### Minor Changes

- 8bead31: Expose lightweight terminal-text and interaction-hints subpaths without loading the full Kit runtime.

## 0.55.0

### Minor Changes

- 3176172: Add opt-in Markdown document rendering with terminal-friendly LaTeX and lazy, width-safe Unicode Mermaid diagrams.

## 0.54.1

### Patch Changes

- 11bdf1e: Update runtime dependencies for chat networking, Starship TOML parsing, and TUI syntax highlighting.

## 0.54.0

### Minor Changes

- 83cdb0d: Add a display-only terminal sanitizer for specialized extension components.
- 7ee5e48: Add optional TUI search to declarative choice screens while keeping RPC deterministic.

## 0.53.0

### Minor Changes

- 4a0358b: Add exact text, code, and diff documents to read-only browse item details while preserving legacy prose behavior.
- 93b507b: Add confirmation-only Live Choice gating so a row can reject its primary action while keeping shortcuts available, with explanatory TUI and RPC presentation and full-disabled precedence.

## 0.52.0

### Minor Changes

- 736ca9e: Add a standalone live-choice interaction, shared choice-selection behavior, and generic interaction-hint formatting.

## 0.51.0

### Minor Changes

- 965f52e: Add disabled reasons and adaptive, ellipsis-safe labels for action rows in TUI and RPC menus.

## 0.50.0

### Minor Changes

- 2d79365: Add `runConfirmation()` with distinct Confirmed, Back, Close, Stale, Unsupported, and Error outcomes across TUI and RPC adapters.
