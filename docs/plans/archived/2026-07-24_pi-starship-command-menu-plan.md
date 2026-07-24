# pi-starship command menu plan

## Goal

Replace bare `/starship` help with a goal-oriented TUI menu, add preview and confirmation before configuration writes, and preserve all direct commands, raw TOML data, and non-TUI behavior.

## Plan

- [x] Add failing command/UI tests for stateful main and Advanced menus, Back navigation, draft preview/confirmation, cancellation, failures, narrow rendering, restore, and direct-command compatibility; initial compilation failed on the missing preview option and draft validator.
- [x] Add in-memory TOML validation and a current-runtime preview callback without changing footer ownership.
- [x] Implement the shallow TUI menu and edit/restore flows with explicit preview, confirmation, atomic application, cancellation, and rollback behavior.
- [x] Update `extensions/pi-starship/README.md` for the final command UX and run focused tests, `npm run check`, package dry-run, and Pi load smoke; all passed.
- [x] Commit and push `6242de9`, create pull request #366, and archive this completed plan.

## Completion Checklist

- [x] Main actions use user goals and expose current configuration health.
- [x] Advanced is one level deep and has a clear Back path.
- [x] Drafts and restore operations preview before a separate confirmation.
- [x] Cancellation and failures preserve the prior file and effective runtime.
- [x] Existing direct routes, autocomplete, non-TUI behavior, and unknown TOML fields remain compatible.
- [x] Menu, detail, and preview components fit narrow terminal widths.
- [x] Documentation and all required verification pass.
