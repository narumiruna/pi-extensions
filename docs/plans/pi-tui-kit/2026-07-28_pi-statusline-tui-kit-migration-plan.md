# pi-statusline pi-tui-kit migration plan

## Goal

Migrate pi-statusline's standard Main and Advanced navigation to `@narumitw/pi-tui-kit` while
preserving live palette previews, information-profile detail previews, the specialized sortable
multiline segment editor, JSON editor, immediate atomic saves, runtime apply/rollback, and direct
settings/status/help routes.

## Context

`extensions/pi-statusline/src/commands.ts` uses basic selectors for Main and Advanced, custom
`SelectList` pickers for palette/information choices, and a highly specialized segment layout editor
with move mode and line-break controls. Only Main and Advanced are standard action screens. Palette
selection has a cursor-movement preview side effect and must restore saved appearance on cancel;
segment layout is explicitly outside the kit's standard multi-select model.

## Architecture

Define Main and Advanced action screens with dynamic labels derived from the latest loaded settings.
Actions dispatch to the existing specialized palette picker, information picker, custom layout,
status/help, and JSON editor. Use kit navigation for Back/Close and stable cursor restoration.

Keep palette and information pickers extension-owned because they update preview/details on selection
rather than confirmation. Keep custom layout extension-owned because it combines visibility,
ordering, move mode, line breaks, immediate persistence, feedback, and narrow responsive viewports.
Do not add preview-on-highlight or sortable-layout hooks to the kit for this migration.

Preserve the existing TUI-only root/settings behavior and observable RPC notifications for direct
routes. Add lifecycle ownership only where tests show an open root menu can outlive the current
session; specialized components retain their own cancellation and rollback.

## Non-Goals

- Migrating palette preview, information preview, segment ordering, JSON editor, or footer rendering.
- Changing presets, segments, settings schema/migration, status icon matching, or save/apply rollback.
- Adding generic sortable or selection-preview APIs to `pi-tui-kit`.

## Risks

- Returning from a specialized picker must restore the root cursor and refresh labels from committed
  state, not a cancelled preview.
- Main labels are display text, not identity; use fixed ids.
- The 941-line command module is near the source limit; extract declarative navigation rather than
  adding another layer in place.

## Plan

- [ ] Add the `<1` kit dependency and lockfile edge; verify boundaries and package metadata.
- [ ] Add failing tests for Main/Advanced dynamic labels, fixed action ids, Back/cursor restoration,
      specialized handoffs, cancelled palette preview restoration, TUI-only behavior, and session
      disposal.
- [ ] Extract typed Main/Advanced screen definitions and replace only their selector loops with
      `runMenu()`, keeping the command module below the 1,000-line boundary; verify focused tests pass.
- [ ] Reconnect palette, information, layout, editor, status, and help actions to existing specialized
      flows and reload committed state after each return; verify preview, narrow-layout, immediate-save,
      malformed-file, runtime-apply, and rollback suites pass.
- [ ] Update README only for standard navigation behavior and package layout if extraction adds a
      module; run package/root checks, root tests, `npm run pack:statusline`, and isolated TUI-harness
      and RPC/direct-route smokes.
- [ ] Audit menu, settings, specialized UI, footer ownership, lifecycle, package, and verification
      conventions before archiving.

## Completion Checklist

- [ ] Main and Advanced use `pi-tui-kit`; all specialized preview/layout/editor surfaces remain local.
- [ ] Cancelled previews, committed labels, immediate saves, rollback, and footer behavior are unchanged.
- [ ] TUI/RPC/direct route and lifecycle behavior is tested.
- [ ] Checks, tests, pack inspection, and smokes pass.
