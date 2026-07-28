# pi-caffeinate pi-tui-kit migration plan

## Goal

Migrate `/caffeinate` controls and the mode selector to `@narumitw/pi-tui-kit` without changing
inhibitor lifecycle, persisted mode ordering/rollback, quiet mode, direct commands, status ownership,
or platform-specific process cleanup.

## Context

`extensions/pi-caffeinate/src/caffeinate.ts` has one standard action menu and one two-item mode
selector. Domain operations already serialize mode changes and guard them with `sessionGeneration`.
The menu itself has no abort signal, and its no-UI fallback currently relies on notifications that are
not observable in print/JSON.

## Architecture

Use Main and Mode action screens with state lines for availability, active process, mode, custom
command, quiet state, and settings errors. Menu actions call the existing queued `setMode()`, status,
stop, and help functions. Add a menu controller replaced with the existing generation at session
start/shutdown and pass its signal plus generation predicate to `runMenu()`.

Keep direct `/caffeinate sleep|display|status|mode|stop|help` routes and their persistence semantics.
RPC may use standard dialog adaptation; print/JSON menu invocation must have an explicit observable
rejection or documented direct-route alternative.

## Non-Goals

- Changing inhibitor commands, process trees, settings schema/migration, environment precedence, or
  quiet/status policy.
- Turning mode into a new settings file abstraction or adding controls for existing JSON-only fields.

## Risks

- A mode change can restart an active inhibitor; menu closure or replacement must not interrupt the
  domain queue halfway through rollback.
- Generic busy UI would misrepresent a process restart that lacks action-scoped cancellation; keep
  the existing mode operation feedback.

## Plan

- [ ] Add the `<1` kit dependency and lockfile edge; verify package boundaries and pack dependency
      metadata.
- [ ] Add failing screen/runtime tests for available, unavailable, disabled, active, custom-command,
      settings-error, current-mode, RPC, no-UI, Back, cancellation, and generation-replacement states.
- [ ] Replace `showMenu()` and `showModeSelector()` with typed Main/Mode action screens and a
      session-owned menu signal while retaining existing domain queues and generation checks; verify
      focused tests and inhibitor lifecycle tests pass.
- [ ] Audit direct route and non-TUI behavior, adding an explicit print/JSON rejection where current
      notifications are no-ops without changing supported TUI/RPC routes; update matching README/tests.
- [ ] Remove only superseded selector constants/dispatch code, then run the package check, root tests,
      root check, `npm run pack:caffeinate`, and an isolated RPC smoke.
- [ ] Audit menu, settings, process lifecycle, status cleanup, command compatibility, and package
      conventions before archiving the plan.

## Completion Checklist

- [ ] Standard controls and mode navigation use `pi-tui-kit` with stable ids and lifecycle ownership.
- [ ] Inhibitor start/restart/stop, save ordering, rollback, quiet mode, and shutdown cleanup are
      unchanged.
- [ ] Direct commands and all documented modes remain observable and tested.
- [ ] Checks, tests, pack inspection, and runtime smoke pass.
