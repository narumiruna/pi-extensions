# @narumitw/pi-btw

## 0.61.0

### Minor Changes

- 865f1d3: Make the split-pane divider draggable and remember the side-thread width.
- 129f324: Add configurable fullscreen, side-thread-left, and side-thread-right workspaces with Pi's live main-thread view and click-to-focus input.

### Patch Changes

- 2bacc07: Use one muted column for the split-pane divider.

## 0.60.3

### Patch Changes

- 34b57b2: Route side-thread requests through Pi's authenticated `modelRegistry.streamSimple()` path so extension-registered providers, OAuth endpoint overrides, headers, and environment credentials are resolved by Pi at request time.

## 0.60.2

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.60.1

### Patch Changes

- 67a3049: Adapt provider, transcript, usage, deferred-tool, and telemetry behavior to Pi's current runtime contracts, including accurate cache-warming accounting and exclusion from ordinary generation traces.

## 0.60.0

### Minor Changes

- c4d403b: Add a searchable model picker to `/btw` Settings with scoped available models, same as the main thread reset, and model-aware thinking choices.

## 0.59.0

### Minor Changes

- 022ba82: Render supported Mermaid fences as width-safe, themed Unicode diagrams in side-thread transcripts, with readable source fallbacks for malformed, unsupported, or oversized diagrams.

### Patch Changes

- ddaccd2: Complete `/btw` fullscreen cancellation by forwarding upstream aborts, closing mounted composers, restoring the parent TUI, and stopping lazy Mermaid transcript preparation when cancelled.

## 0.58.1

### Patch Changes

- ad0fbc0: Honor the API base URL returned by Pi's authentication resolver for both inherited and explicitly configured side-thread models. This fixes misdirected requests for GitHub Copilot accounts that use a different endpoint from the provider default, without changing the main session's model.

## 0.58.0

### Minor Changes

- 609f6a8: Add BTW-only exit, thinking-cycle, and bring-to-main keybindings in `/btw` → Settings, with conflict validation and per-action reset. Preserve Ctrl+C as hard cancel and keep pasted input out of shortcut handling.

### Patch Changes

- Updated dependencies [317f7bd]
  - @narumitw/pi-tui-kit@0.61.0

## 0.57.1

### Patch Changes

- ee07eb8: Forward Pi session headers to OpenCode providers for side-thread requests.

## 0.57.0

### Minor Changes

- f24a5b0: Add a themed, clickable Jump to latest control that honors Pi's effective fullscreen bottom keybinding.

## 0.56.2

### Patch Changes

- c0fe03e: Wait for Pi's terminal input drain before restoring the parent fullscreen TUI after Ctrl+C.

## 0.56.1

### Patch Changes

- 612df75: Defer Ctrl+C terminal restoration until input dispatch finishes so Windows fullscreen sessions redraw and scroll correctly.

## 0.56.0

### Minor Changes

- f41734c: Add configurable manual fullscreen selection copying through Pi's effective copy keybinding, with paste-safe input and compatibility checks.

## 0.55.4

### Patch Changes

- Updated dependencies [40182e5]
  - @narumitw/pi-tui-kit@0.59.0

## 0.55.3

### Patch Changes

- 4fb170b: Restore main-editor input immediately after Ctrl+C exits a dedicated side thread.
- 2250f3c: Close the active side flow when Ctrl+C restores the main editor while transcript search has focus.
- Updated dependencies [78276b0]
- Updated dependencies [dc9802e]
  - @narumitw/pi-tui-kit@0.58.1

## 0.55.2

### Patch Changes

- Updated dependencies [b9eba3a]
  - @narumitw/pi-tui-kit@0.58.0

## 0.55.1

### Patch Changes

- Updated dependencies [6574232]
- Updated dependencies [cddc265]
  - @narumitw/pi-tui-kit@0.57.0

## 0.55.0

### Minor Changes

- 79bc155: Add themed fullscreen transcript search and verified host clipboard feedback for mouse selections.

## 0.54.2

### Patch Changes

- 30bc076: Load each extension from a generated TypeScript runtime to reduce Jiti package startup work while preserving existing first-use boundaries.

## 0.54.1

### Patch Changes

- Updated dependencies [8bead31]
  - @narumitw/pi-tui-kit@0.56.0

## 0.54.0

### Minor Changes

- b5c0682: Add native mouse-wheel and trackpad scrolling to side-thread transcript history.

## 0.53.0

### Minor Changes

- d97edfd: Add a native main-session tree picker that starts a fresh side thread from any selected branch without switching the main conversation.

### Patch Changes

- Updated dependencies [3176172]
  - @narumitw/pi-tui-kit@0.55.0

## 0.52.0

### Minor Changes

- f3d76af: Add a Same as main thread thinking option that starts new side threads from the current main thread level while keeping shortcut changes local.

## 0.51.0

### Minor Changes

- 69e8485: Add local fuzzy search to the in-memory Resume thread choice.

## 0.50.0

### Minor Changes

- be8d492: Add an in-memory Resume picker to `/btw` so the current Pi session can continue any non-empty side thread by its first question while `/btw <question>` remains a fresh-thread fast path.

## 0.49.7

### Patch Changes

- 3f33860: Run side threads in a dedicated full-screen TUI so mouse-drag copying stays stable while the main agent continues producing output in the background.
- 2a2c9c1: Queue Pi-style steering questions while a side-thread answer is running, process them one at a time without touching the main conversation, and report malformed side-model responses without hanging the side UI.

## 0.49.6

### Patch Changes

- a4b44ee: Route side-question completions through Pi's effective runtime provider so custom provider APIs work.
