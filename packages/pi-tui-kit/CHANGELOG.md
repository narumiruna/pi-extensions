# @narumitw/pi-tui-kit

## 0.68.0

### Minor Changes

- a21d39b: Add opt-in editor status presentation helpers for stable snapshot publication, session-local view controls, and bounded whole-snapshot collections. Keep the existing EditorStatusWidget API unchanged.
  
  Retain visible Progress, Subagents, and Herdr widgets during updates. Add bounded summaries, manual view and item controls, and explicit one-shot compaction policies to Progress and Subagents without changing task state or persistent defaults. Preserve Progress completion retention and keep Herdr observation policies local. Keep tree navigation and manual context compaction separate from response-cycle tracking.

### Patch Changes

- f68aa54: Use Pi TUI's public terminal-sequence helper when checking selected-label visibility, including cursor markers. Remove the unused internal selection controller from the package output without changing public exports.
- b062d21: Keep choice names, current markers, and settings values readable at narrow terminal widths with explicit truncation and full selected context. Add searchable-choice result counts, preserve browse names beside long status text, and allow compact browse search recovery without focusing a hidden input.

## 0.67.0

### Minor Changes

- 57eeae7: Add the opt-in `createFullscreenHandoff()` resource and native test harness. Share terminal entry/exit drain, cancellation-safe restoration, keyboard-protocol recovery, owned overlay handling, and cleanup errors through public Pi TUI APIs. Keep ordinary Kit interactions unchanged.
  
  Use the resource in Starship's configuration chat and BTW's multi-screen workspace. Keep each extension's input policy, layouts, domain state, permissions, and persistence local. BTW now waits for native input drain before entry. Changesets raises both consumer floors to the Kit API release; dependent publication requires its exact registry artifact.

## 0.66.0

### Minor Changes

- 077137a: Add optional in-place full-source Copy to review screens, standalone document reviews, and exact browse-detail documents through consumer-owned callbacks.
  
  Preserve existing completion and confirmation contracts. Filter effective copy hints, keep search and standard actions first, drain accepted work on exit, and report retryable failures without exposing source-bearing callback errors. RPC never exposes or invokes Copy; no clipboard transport is included.
- 9f80b89: Expose typed bounded-frame row mappings and configured-key canonicalization while retaining existing frame output and native input ownership.
  
  Use native fake-cursor markers for masked input so hardware-cursor mode does not draw a second cursor, and keep secret rendering within zero or invalid width bounds.
  
  New frame and key APIs are prepared before consumer adoption; protocol-overlap, global availability, and a second paste parser remain deferred.

### Patch Changes

- efc474c: Keep selected rows, descriptions, and empty-search guidance usable in clipped selectors. Omit interaction hints for keys owned by Pi's native host while preserving document-local search, editing, cancellation, and asynchronous settlement.

## 0.65.6

### Patch Changes

- 8b5e7bb: Rebuild task-loader cancellation hint colors after theme invalidation and bound loader output at narrow or unusable widths. Preserve cancellation bindings and task cleanup behavior.

## 0.65.5

### Patch Changes

- 6a2f900: Drain asynchronous custom-component creation after early host completion, dispose late components exactly once, and abort interaction work immediately on accepted completion without turning completion-triggered factory or cleanup cancellation into an error. Suppress delayed fallback error notifications after interaction or task ownership ends, and keep review rendering within zero-width and non-finite display bounds.
- 80eef72: Flatten the sync manager: expose reviewed Pull, Push, History, and Diagnostics directly, move destination and catalog management into searchable Settings, and show conflict/access recovery only when applicable. Preserve existing commands, automation policies, and safety confirmations.
  
  Require the TUI Kit patch that preserves Settings search and cursor across refreshes, including queries that match printable keybindings.
  
  Preserve Settings search and cursor across successful refreshes in TUI Kit, and restore Settings and Choice queries as sanitized pasted content without dispatching printable keybindings.

## 0.65.3

### Patch Changes

- 178e2e4: Request a render after deferred custom-answer submission, and isolate answer and note editor generations so earlier asynchronous callbacks cannot overwrite a later edit. Preserve pending key-release delivery to its owning editor and dispose retired editor instances after their key cycles drain.

## 0.65.2

### Patch Changes

- 000bd50: Use Pi's publicly configured custom editor factory for TUI questionnaire answers and notes. Custom editors own editing and submission keys, while Ctrl+C remains hard cancellation and the main prompt editor stays untouched. Preserve raw expanded drafts, fragmented paste safety, default-editor and non-TUI behavior, and release questionnaire-owned editor instances when the interaction ends.
  
  Honor custom editor submission values without replacing intentional normalization with the original draft, and retain editor-owned key-release cycles across answer and note transitions.

## 0.65.1

### Patch Changes

- e6db042: Share internal standalone-interaction error reporting while preserving the original callback await timing, runner-owned lifecycle checks, typed outcomes, notification labels, and sanitizers.

## 0.65.0

### Minor Changes

- 9ad07cf: Add focused interaction subpaths and standalone document-review and multi-select runners with lifecycle-safe TUI and RPC adaptation.

## 0.64.0

### Minor Changes

- 9df8964: Expose lazy Mermaid Markdown renderer preparation and a synchronous final-message transformer from the package root and the focused `/markdown` subpath.

## 0.63.1

### Patch Changes

- d365daa: Publish and document Diff 9 as the runtime dependency used for text comparisons.

## 0.63.0

### Minor Changes

- 393783f: Add standard-screen mouse routing, compatible thinking-selector save bindings, bounded intraline diff emphasis, searchable live choices, editable input prefill, and a TUI-only masked secret interaction.

### Patch Changes

- 845bb04: Keep optimistic setting values stable when an older rejected save requests the same value as a newer queued change.

## 0.62.0

### Minor Changes

- 6b1e009: Add searchable default-aware selectors with current/default markers and effective Ctrl+S save-default actions.

### Patch Changes

- 4485b49: Fix forwarded selector submissions, accurate shortcut hints across legacy and extended keyboard protocols, and thinking-level descriptions.

## 0.61.0

### Minor Changes

- 317f7bd: Expose a stateless bounded-frame renderer with caller-owned row priorities, and reuse it in standard menus without changing their input or save lifecycle.

## 0.60.0

### Minor Changes

- fc6fab5: Add opt-in search to review screens and browse detail views.
  
  Export multiline terminal-document sanitization and cell-aware hard-wrapping helpers.

### Patch Changes

- 636fd3c: Keep stored document-search queries bounded and deduplicate wrapped Markdown table results by logical cell occurrences.

## 0.59.0

### Minor Changes

- 40182e5: Add a width-safe `EditorStatusWidget` presentation frame for passive status and progress rows near Pi's editor.

## 0.58.2

### Patch Changes

- 663f72a: Keep framed choices, settings, searchable inputs, and review pagination usable within Pi's available terminal rows.

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
