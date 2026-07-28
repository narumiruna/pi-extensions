# pi-jupyter pi-tui-kit migration plan

## Goal

Migrate experimental pi-jupyter's standard current-state menu, notebook picker, and help screen to
`@narumitw/pi-tui-kit` while preserving the specialized notebook overlay/panel, atomic notebook
switching, cancellable loader, explicit-path confirmation, watcher lifecycle, focus/scroll shortcuts,
direct routes, TUI-only contract, and experimental warning.

## Context

`experimental/pi-jupyter/src/jupyter-menu.ts` owns custom `SelectList` wrappers for the main menu and
workspace notebook picker plus a read-only help component. `jupyter-preview.ts` owns the actual
responsive overlay, mouse resizing, file watcher, generations, last-valid notebook state, and a
`BorderedLoader` used when a menu selection loads a notebook. Those specialized responsibilities do
not belong in the kit.

The standard menus fit the current kit API. The main summary currently includes one terminal-width
condition; keep exact responsive visibility in the specialized panel and report the fixed 90-column
threshold in declarative menu guidance rather than adding a Jupyter-specific responsive-screen hook
to the shared package.

## Architecture

- Define stable Main, Notebook Picker, and Help screens. Main state derives from selected path,
  visible/focused state, cell count, last load/error, and the fixed narrow-terminal threshold.
- Discover top-level notebooks when entering the picker, use normalized absolute paths as raw action
  payloads, and retain the explicit Enter a path action. Keep basename/path text sanitized only for
  display.
- Retain `loadFromMenu()` as the specialized cancellable loader so notebook parsing, cancellation,
  atomic replacement, watcher installation, and last-valid fallback stay one operation. The kit
  controls only the screens before and after it.
- Add a session-owned menu controller/generation, abort it on `session_start` replacement and
  `session_shutdown`, and combine it with selection/refresh generations through `runMenu()`'s signal
  and `isCurrent()` guard.
- Keep the preview overlay, focus, scrolling, watcher/debounce, mouse listener, panel geometry, input,
  outside-workspace confirmation, and shortcuts extension-owned.
- Preserve the `requireTui()` guard for no-argument and direct commands. RPC, print, and JSON continue
  to fail observably before any menu, watcher, or overlay starts.

## Non-Goals

- Migrating or redesigning `NotebookPreviewPanel`, overlay positioning/resizing, notebook rendering,
  filesystem validation, watcher/debounce logic, or keyboard shortcuts.
- Adding settings, RPC preview support, recursive notebook discovery, search, or a responsive custom
  screen escape hatch to `pi-tui-kit`.
- Removing advanced direct `/jupyter` routes or the runtime experimental warning.

## Risks

- A slower notebook load or watcher refresh can race a newer selection. Preserve separate selection
  and refresh generations in addition to menu ownership.
- Opening the preview from a menu action starts an overlay whose promise outlives the menu. Do not let
  menu cleanup dispose or reuse the overlay component; shutdown remains its owner.
- Back from the picker and Ctrl+C close are distinct. Keep kit screen hints and specialized input/
  loader outcomes mapped explicitly.
- A static menu cannot know the callback TUI width before rendering. Do not weaken the overlay's
  actual responsive predicate; test the menu's threshold guidance and panel behavior separately.

## Plan

- [ ] Add the `<1` kit runtime dependency and lockfile edge to experimental `pi-jupyter`; verify
      package boundaries, experimental publishing metadata, and `npm run pack:jupyter` contents.
- [ ] Add failing screen/runtime tests for no-selection, closed, open, focused, stale-error,
      narrow-threshold, empty/multiple-notebook, current-path, explicit-path, duplicate-looking label,
      Back/Close, cursor restoration, owner abort, and TUI-only states.
- [ ] Replace `createJupyterMenuComponent()` and `createJupyterHelpComponent()` with typed action/detail
      screens, retaining current-state ordering and selected action identity; verify Open, Focus,
      Refresh, Close, Help, and cancellation do not alter overlay lifecycle unexpectedly.
- [ ] Replace `createNotebookPickerComponent()` with a dynamic action screen, preserving discovery,
      raw path identity, explicit input, outside-workspace confirmation, Back versus Close, and
      successful-load-only selection replacement.
- [ ] Wire selected-path actions through the existing cancellable loader and session/generation
      signals; add disposal and replacement tests proving aborted loads cannot start a watcher,
      replace the model, open an overlay, or publish stale status.
- [ ] Remove only superseded selector/hint code after overlay, watcher, mouse, width, scroll, direct
      command, and shortcut tests remain green; keep the experimental warning and specialized panel
      modules unchanged.
- [ ] Update the README for standard menu navigation and the unchanged TUI-only/experimental
      contract, then run the package typecheck, root tests, `npm run check`, `npm run pack:jupyter`,
      and an isolated `pi -e ./experimental/pi-jupyter` load plus TUI-harness smoke with a temporary
      notebook.
- [ ] Audit command, TUI, overlay, cancellation/disposal, watcher/session lifecycle, filesystem
      safety, experimental packaging, and verification conventions before archiving.

## Completion Checklist

- [ ] Main, Notebook Picker, and Help use `pi-tui-kit` standard screens.
- [ ] Overlay/panel, loader, input/confirmation, watcher, atomic switch, focus/scroll, and direct routes
      remain extension-owned and unchanged.
- [ ] Back/Close, cancellation, disposal, replacement, TUI-only behavior, and experimental warning are
      covered.
- [ ] Focused tests, root checks, runtime/TUI smoke, and pack inspection pass.
