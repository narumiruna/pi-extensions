## Goal

Let TUI users reorder visible pi-statusline segments as well as show or hide them, with each change persisted and applied immediately.

## Architecture

- Replace the toggle-only `SettingsList` screen with a bounded segment list that presents visible segments in their effective order followed by hidden segments.
- Keep standard navigation, toggle, and cancellation on Pi's injected keybindings; use `Alt+Up` and `Alt+Down` for the screen-specific reorder action.
- Reorder only visible data segments. Swap their positions around existing `line_break` markers so multiline row boundaries remain intact.
- Reuse the existing atomic settings save and runtime rollback behavior for both toggles and reorders.

## Plan

- [x] Add focused failing command tests for visible ordering, `Alt+Up`/`Alt+Down` persistence, immediate runtime application, multiline preservation, and save rollback; the focused run failed on unchanged order and missing save feedback before implementation.
- [x] Implement the sortable segment TUI and transactional document update in `extensions/pi-statusline/src/commands.ts`; all five focused segment-menu tests and the package typecheck pass.
- [x] Update `extensions/pi-statusline/README.md` and command help, format intended files, and run `npm run check` plus `just pack-statusline`; the full gate passed all 1,183 tests and the 24-file dry-run tarball includes the updated source and README.

## Completion Checklist

- [x] The Segments screen exposes current effective order and discoverable reorder keys while retaining show/hide controls.
- [x] Reorders save and render immediately, preserve unknown JSON fields and `line_break` positions, and leave hidden segments unchanged.
- [x] Failed saves or runtime application leave the file, runtime state, and displayed order unchanged.
- [x] Repository checks and the statusline package dry run pass.
