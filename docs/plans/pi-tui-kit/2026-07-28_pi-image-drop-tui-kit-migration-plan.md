# pi-image-drop pi-tui-kit migration plan

## Goal

Migrate pi-image-drop's standard Main, Status, Help, Settings, and resource-limit navigation to
`@narumitw/pi-tui-kit` while preserving its TUI-only command contract, browser server and image-batch
lifecycle, cancellable settings/status loads, transactional limit draft, exact confirmations, focused
input, ordered settings writes, and session-replacement guards.

## Context

`extensions/pi-image-drop/src/menu.ts` implements reusable action-screen, settings, status, limits,
and help components directly with `SelectList` and `SettingsList`. It also contains specialized
`BorderedLoader`, `Input`, and confirmation components that distinguish Escape (Back/Cancel) from
Ctrl+C (close the entire Image Drop flow). `extensions/pi-image-drop/src/runtime.ts` already owns a
session `AbortController`, generation, settings transactions, browser server, processor, batch, and
stale-continuation checks.

The standard screen shells fit the kit. Cancellable loaders, the IME-capable numeric input,
confirmation previews, browser assets, and draft/commit logic remain extension-owned.

## Architecture

- Define stable Main, Status, Help, Settings, Limits, and invalid-settings screens. Derive screen
  lines from current batch/history/server/model/settings state without starting the browser service.
- Pass the existing `sessionAbort.signal` and `isCurrentMenu(generation)` predicate to `runMenu()`;
  do not create a second lifecycle protocol.
- Keep status and settings reads behind the existing extension-owned loader so Escape and Ctrl+C
  retain distinct outcomes and each read combines loader cancellation with the session signal. Store
  only the latest valid loaded snapshot before navigating to a standard screen.
- Use a kit Settings screen for automatic startup and navigation to Limits. Continue to call
  `updateSettings()` for each immediate toggle and reject the visual change when the extension
  transaction fails or becomes stale.
- Keep the six resource limits in a standard action screen backed by an extension-owned draft.
  Numeric input, relationship validation, Restore Defaults staging, exact review confirmation, and
  one atomic patch publication remain outside the kit.
- Preserve the `/image-drop` TUI-only guard before `runMenu()`. RPC receives the existing warning;
  print/JSON throw the existing observable error and never start the service.

## Non-Goals

- Changing browser routes/assets, image processing, retention, batch reservation/recovery, Pi image
  settings precedence, settings schema, hard limits, or service startup policy.
- Moving the loader, focused numeric input, confirmation semantics, transaction draft, or server
  operations into `pi-tui-kit`.
- Adding direct command subroutes or enabling Image Drop's menu outside TUI mode.

## Risks

- Replacing the custom loader with a generic busy action would collapse Escape and Ctrl+C and weaken
  task disposal. Retain and test the specialized loader.
- The current session's batch limits intentionally do not change when future-session settings are
  saved. Screen state must not apply the draft to `BatchStore`.
- Rapid automatic-start changes must enqueue before earlier saves settle. Keep extension persistence
  as the authoritative queue even though the kit also serializes screen callbacks.
- A server may start while the session is replaced. Every post-await continuation must retain the
  existing generation and session-signal checks before publishing a link, widget, notification, or
  screen transition.

## Plan

- [ ] Add the `<1` kit runtime dependency and lockfile edge to `pi-image-drop`; verify boundaries and
      `npm run pack:image-drop` include the built library dependency without changing browser assets.
- [ ] Add failing declarative screen/runtime tests for empty, processing, blocked, reserved, retained,
      running-server, text-only-model, invalid-settings, recommended/custom-limit, pending-draft, and
      failed-refresh states; cover stable ids, Back/Close, cursor restoration, narrow widths, owner
      abort, and TUI-only rejection.
- [ ] Replace the Main, Status, and Help wrappers with typed action/detail screens wired to the
      existing generation and session signal; verify opening/cancelling the menu remains side-effect
      free and only the Open action can start or rotate the server link.
- [ ] Replace the settings wrapper with a kit Settings screen while preserving loader cancellation,
      unknown-field-safe atomic updates, rapid-change ordering, failed-save rollback, invalid-file
      read-only guidance, and next-session-only application.
- [ ] Replace the Limits action wrapper with a standard screen backed by the existing draft, keeping
      `showImageDropInputDialog()`, `showImageDropConfirmDialog()`, validation, Restore Defaults, and
      review/save commit extension-owned; verify Escape/Back and Ctrl+C/Close outcomes at every nested
      step.
- [ ] Remove only superseded `SelectList`/`SettingsList` and hint code after focused tests prove IME
      focus forwarding, theme invalidation, width bounds, loader disposal, pending-save draining, and
      stale-session suppression remain covered.
- [ ] Update the package README only for standard menu navigation, then run the package typecheck and
      web asset check, root tests, `npm run check`, `npm run pack:image-drop`, and an isolated
      `pi -e ./extensions/pi-image-drop` load/TUI-harness smoke; inspect generated assets and tarball
      contents for unintended changes.
- [ ] Audit command, TUI, cancellation, disposal, session replacement, settings, batch/server
      lifecycle, package, generated-asset, and verification conventions before archiving.

## Completion Checklist

- [ ] Main, Status, Help, Settings, Limits, and invalid-settings standard screens use `pi-tui-kit`.
- [ ] Loader, input, confirmation, limit draft, browser server, processor, batch, and settings
      transactions remain extension-owned and behaviorally unchanged.
- [ ] Escape/Ctrl+C, disposal, session replacement, TUI-only modes, and pending writes are covered.
- [ ] Focused tests, web checks, root checks, runtime load, and pack inspection pass.
