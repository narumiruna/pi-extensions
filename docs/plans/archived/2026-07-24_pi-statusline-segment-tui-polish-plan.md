## Goal

Resolve the segment TUI usability findings by making multiline layout, visible/hidden grouping, controls, unavailable actions, and low-height behavior explicit without weakening immediate persistence or rollback.

## Architecture

- Keep one segment screen, but render visible and hidden sections through a six-item viewport.
- Label each visible segment with its footer row derived from `line_break` positions.
- Wrap control hints instead of truncating them and retain `Alt+Up`/`Alt+Down` as quick actions.
- Add a modifier-free Move mode so terminals that cannot report modified arrows can reorder with ordinary Up/Down.
- Show contextual in-screen feedback when a hidden or boundary segment cannot move.

## Plan

- [x] Add focused failing command tests for row labels, section headings, wrapped narrow-width hints, bounded viewport height, Move mode, and unavailable-move feedback; the focused run failed on unbounded height and absent contextual feedback before implementation.
- [x] Implement the polished segment component in `extensions/pi-statusline/src/commands.ts`; all six focused segment-menu tests pass.
- [x] Update `extensions/pi-statusline/README.md` and command help, format intended files, then run `npm run check` and `just pack-statusline`; the full gate passed all 1,184 tests and the 24-file dry-run tarball includes the updated source and README.

## Completion Checklist

- [x] Multiline row boundaries and visible/hidden ownership are recognizable without relying on color.
- [x] Every control remains discoverable at narrow widths, and reordering works without modified-arrow support.
- [x] Hidden and boundary moves explain why no change occurred.
- [x] The list remains bounded while preserving selection context, immediate saves, rollback, and Escape behavior.
- [x] Repository checks and the statusline package dry run pass.
