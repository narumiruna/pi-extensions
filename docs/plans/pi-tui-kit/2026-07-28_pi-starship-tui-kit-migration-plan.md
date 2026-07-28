# pi-starship pi-tui-kit migration plan

## Goal

Migrate pi-starship's standard Main, Advanced, configuration detail, diagnostics, and help navigation
to `@narumitw/pi-tui-kit` while preserving the specialized TOML editor, width-dependent live footer
preview, confirmation, atomic save/apply/rollback, and direct command compatibility.

## Context

`extensions/pi-starship/src/commands.ts` repeats a custom `SelectList` action-screen wrapper for both
standard navigation and specialized preview screens. Main and Advanced are ordinary action menus;
configuration health/details/help are read-only detail flows. Footer previews depend on terminal width
and extension rendering, so they remain specialized rather than being flattened into static kit
lines.

## Architecture

Define Main and Advanced action screens plus detail screens for diagnostics, configuration details,
and help. `getState()` reads the latest loaded configuration synchronously for each screen so source,
health, warnings, and restore availability refresh after actions. Standard actions use stable ids and
kit navigation; Customize and Restore call existing editor/review/apply flows.

Retain a small extension-owned preview component for `previewBody(width)` and invalid-draft recovery.
Do not introduce a generic custom-screen escape hatch into the kit. The command runs only standard
menus in TUI; RPC/other modes preserve the current help/manual-path notifications and direct routes.
Add a package-local menu owner only if lifecycle tests show a command screen can survive session
replacement; otherwise use the command invocation boundary and explicit current checks.

## Non-Goals

- Migrating the TOML editor, width-aware footer preview, or apply/rollback confirmation.
- Changing format grammar, modules, defaults, settings file, footer rendering, or conflict policy.
- Adding new menu hierarchy or removing direct settings/status/help routes.

## Risks

- Static detail lines cannot replace the width-aware live footer preview; keep it specialized.
- Restore/apply failures can require file and runtime rollback. Generic menu transitions must occur
  only after the existing transaction reports a final outcome.
- Diagnostics can contain terminal controls; retain `safeText()` before screen construction.

## Plan

- [ ] Add the `<1` kit dependency and lockfile edge; verify package boundaries and runtime metadata.
- [ ] Add failing tests for Main/Advanced/detail navigation, dynamic health/source state, Back/cursor
      restoration, restore availability, TUI cancellation, and non-TUI direct-route fallbacks.
- [ ] Replace standard `showActionMenu()` uses with typed action/detail screens while retaining a
      dedicated preview UI for width-rendered footer drafts and invalid-draft recovery; verify focused
      menu and width tests pass.
- [ ] Route Customize and Restore through existing editor, validation, preview, confirmation,
      save/apply, and rollback code; verify malformed-file, warning, atomic publication, application
      failure, and rollback tests remain green.
- [ ] Remove only the superseded standard wrapper code and update README navigation/key wording if
      needed; run package/root checks, root tests, `npm run pack:starship`, and an isolated TUI-harness
      plus noninteractive load smoke.
- [ ] Audit menu, settings, custom preview, footer lifecycle, package, and verification conventions
      before archiving.

## Completion Checklist

- [ ] Main/Advanced/details/diagnostics/help use `pi-tui-kit`.
- [ ] TOML editing and width-aware review remain specialized and fully transactional.
- [ ] Direct routes, settings, footer behavior, rollback, and mode behavior are unchanged.
- [ ] Tests, checks, pack inspection, and smokes pass.
