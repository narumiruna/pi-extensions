## Goal

Let TUI users choose which data segments pi-statusline currently displays from the `/statusline`
menu, with immediate persistent application and safe recovery when settings cannot be saved.

## Architecture

- Add a `Segments` action to the existing argument-free `/statusline` menu.
- Use Pi's `SettingsList` for one visible/hidden toggle per data segment; keep `line_break` in the
  advanced JSON layout editor because it controls rows rather than displayed data.
- Preserve the relative order of segments that remain visible. Append newly enabled segments to the
  final row, and remove leading, trailing, or newly consecutive `line_break` entries after a toggle.
- Update only the root `segments` field in the existing raw JSON document so unknown fields and all
  other settings remain unchanged.
- Save through the existing atomic validator, apply the loaded settings immediately, and restore the
  displayed toggle on any validation or persistence failure.

## Plan

- [x] Add focused failing command tests for opening the Segments screen, immediate visible/hidden
  toggles, order/layout normalization, unknown-field preservation, cancellation, and save rollback.
  Red evidence: `npm test` failed only the three menu expectations introduced/updated for this UI.
- [x] Implement the Segments `SettingsList` screen and transactional `segments` document update in
  `extensions/pi-statusline/src/commands.ts`; `npm test` passes all 1,181 tests, including save and
  runtime-application rollback.
- [x] Update `extensions/pi-statusline/README.md` and menu help to document interactive segment
  selection, immediate persistence, ordering behavior, and `line_break` ownership.
- [x] Format intended files and run `npm run check` plus `just pack-statusline`; the full gate passed
  all 1,181 tests and the 24-file tarball includes `src/commands.ts` and `README.md`.

## Completion Checklist

- [x] `/statusline` exposes a discoverable Segments action showing the current visible count.
- [x] Every data segment can be enabled or disabled without reopening the screen, and the footer
  receives each successful change immediately.
- [x] Existing order, valid line breaks, unknown JSON fields, and unrelated settings are preserved;
  failed writes leave file, runtime state, and displayed state unchanged.
- [x] Non-TUI behavior and established `/statusline settings|status|help` routes remain unchanged.
- [x] Focused tests, repository CI-equivalent checks, and the statusline pack dry run pass.
