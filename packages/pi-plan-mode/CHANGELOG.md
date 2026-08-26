# @narumitw/pi-plan-mode

## 0.55.0

### Minor Changes

- b59cdbc: Remove the `toolVisibility` setting and keep Plan helper schemas stable from startup.
  Retired settings keys are ignored and preserved, while globally visible helper metadata now distinguishes `/plan` from ordinary planning workflows.

## 0.54.0

### Minor Changes

- ab467e0: Allow Pi's active native PowerShell tool to run reviewed read-only file, directory, Git, and GitHub inspections in Plan mode while blocking mutation and unsupported dynamic syntax.

## 0.53.1

### Patch Changes

- 02878f5: Add an editor-style divider above the Plan mode widget.
- 3346683: Publish generated lazy chunks at the JavaScript paths referenced by each extension runtime so deferred menus and implementations load correctly through Pi's Jiti loader.
- Updated dependencies [b9eba3a]
  - @narumitw/pi-tui-kit@0.58.0

## 0.53.0

### Minor Changes

- c194597: Make conversation-history-only implementation the default, use Codex-style kickoff prompts without active-plan injection, and clarify Plan reinjection controls.
- e74ee84: Add configurable Plan helper visibility and default to revealing the helper tools on the first successful Plan activation.
- 67eb77b: Remove the `--plan` startup flag. Start Plan mode after launch with `/plan start` or begin with a prompt through `/plan <prompt>`.
- da265a0: Keep Plan and Normal requests on one append-only conversation with stable tool schemas, versioned mode contracts, and a runtime Plan tool allowlist that no longer activates inactive tools.

### Patch Changes

- df584db: Keep unused resumed sessions free of mode contracts and reject `/tree` navigation to internal transition markers.
- 5be9aa2: Prevent active agent runs from mixing Plan and Normal tool contracts, and retry explicit structured finalization once after settlement when the model responds with prose only.

## 0.52.0

### Minor Changes

- 85d13c8: Coordinate Plan-mode activation through Workflow Mutex Protocol v1 so cooperating agent workflows cannot start in the same Pi session.

## 0.51.1

### Patch Changes

- 8540d0f: Simplify single-question TUI questionnaires with a plain header and immediate answer submission while retaining tabbed Review for multiple questions.
- 5785cb4: Reuse Pi TUI Kit's questionnaire runner while preserving Plan mode answer and lifecycle behavior.
- Updated dependencies [8540d0f]
  - @narumitw/pi-tui-kit@0.57.1

## 0.51.0

### Minor Changes

- 416da47: Add tabbed TUI Plan questions with answer notes and final review.

## 0.50.1

### Patch Changes

- 30bc076: Load each extension from a generated TypeScript runtime to reduce Jiti package startup work while preserving existing first-use boundaries.

## 0.50.0

### Minor Changes

- 160f2fc: Add an optional `toggleShortcut` setting and a **Plan mode shortcut** Settings row so the global Plan-mode keybinding can be chosen, and keep it disabled while the setting is omitted. Reload the settings file automatically when it changes and rebind the configured shortcut immediately after a Settings save.
