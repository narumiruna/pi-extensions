# @narumitw/pi-notes

## 0.2.6

### Patch Changes

- Updated dependencies [cf7b63d]
  - @narumitw/pi-tui-kit@0.70.0

## 0.2.5

### Patch Changes

- 54f2700: Preserve fullscreen viewport capture through custom list wrappers so default and configured paging keys reach the focused list. Keep native transcript search, unrelated overlays, free-text modes, paste, and hard cancellation unchanged. Filter Kit key hints according to each screen's capture policy.
  
  Update Recall and File Context to the current Kit dependency range. The selected consumer releases require the fixed Kit patch through Changesets dependency-floor updates.
- 6c76ef1: Report inline Plan questions, Notes template editing, and Progress settings as waiting for user input on supported Pi hosts and terminals. Add optional consumer-owned blocked metadata to Kit custom interactions and questionnaires without marking loaders or changing RPC and print behavior. Settle host-disposed interactions and drain their work without interrupting native reset or restoring stale editor drafts.
- e484010: Include the existing package-root CHANGELOG.md in extension tarballs so Pi can show native update notices. Keep Changesets version headings and Pi's first-observation and collapseChangelog behavior unchanged.
- 5120d4d: Preserve TypeBox enum inference for direct imports and Pi's extension loader without changing provider-visible schemas or validation rules. Import Notes schemas from TypeBox, declare its host-provided peer, and complete Worktree's command result contract for the updated Pi APIs.
- Updated dependencies [54f2700]
- Updated dependencies [6c76ef1]
  - @narumitw/pi-tui-kit@0.69.0

## 0.2.4

### Patch Changes

- 9d3e0d7: Prevent passive UI timers from keeping Node alive while preserving status expiry, settings reloads, paste handling, and cleanup.
- Updated dependencies [9d3e0d7]
  - @narumitw/pi-tui-kit@0.68.1

## 0.2.3

### Patch Changes

- Updated dependencies [a21d39b]
- Updated dependencies [f68aa54]
- Updated dependencies [b062d21]
  - @narumitw/pi-tui-kit@0.68.0

## 0.2.2

### Patch Changes

- Updated dependencies [57eeae7]
  - @narumitw/pi-tui-kit@0.67.0

## 0.2.1

### Patch Changes

- 168248c: Reuse published TUI Kit frame metadata, masked input, configured-key syntax, and interaction ownership while retaining extension-owned settings and cancellation policy. Keep malformed Ticker key strings from suppressing valid reorder shortcuts, and drain Usage settings saves after cancellation.

## 0.2.0

### Minor Changes

- 648b8c3: Delete the highlighted note from the Open a note picker with confirmation, stale-revision protection, and configurable Pi keybindings.

## 0.1.0

### Minor Changes

- e2794e8: Publish the agent-assisted Markdown notes workspace with direct note opening, control-safe canonical path insertion into the parent draft, and raw-preserving, stale-safe template editing that preserves Pi's tmux paste decoding and focused-editor key precedence.
- c26ea75: Create notes under collision-safe temporary names without a filename prompt, and let the embedded note agent rename the current note through a revision-checked tool.
