# pi-webui pi-tui-kit migration plan

## Goal

Migrate experimental pi-webui's current-state manager, status/repair/help details, and startup setting
to `@narumitw/pi-tui-kit` while preserving browser server and conversation lifecycle, fresh-link
security, ordered settings persistence, invalid-file protection, RPC/manual-settings behavior, direct
routes, generated browser assets, and the experimental warning.

## Context

`experimental/pi-webui/src/menu.ts` implements a standard current-state `SelectList` and detail
component. `runtime.ts` separately implements TUI/RPC menu loops and a custom `SettingsList` for one
startup toggle. The runtime already owns a session abort signal, generation, settings save queue,
server/conversation state, browser-input protocol, and stale-continuation checks.

The standard manager/details/settings fit the current kit. Browser UI, one-time links, HTTP/SSE
state, image processing, conversation projection, and settings storage remain extension-owned.

## Architecture

- Define stable Main, Status, Repair, Help, and Startup Settings screens. Recompute server, startup,
  source, invalid-file, image-limit, and path lines on each screen entry while keeping token-bearing
  links out of all screen state.
- Pass the existing `sessionAbort.signal` and a `generation === current && !closed` predicate to
  `runMenu()`; do not introduce a parallel lifecycle controller.
- Preserve RPC manager adaptation for Main and details. The Settings action may navigate to the kit
  Settings screen only in TUI; in RPC it reports the manual path and stays, matching the current
  non-mutating contract. Print/JSON remain side-effect free.
- Keep `settingsSaveQueue` as the authoritative ordering protocol across UI, lifecycle, and direct
  routes. A kit setting action enqueues and awaits one `saveSettings()` operation, updates runtime
  state only for the current generation, and rejects so the kit rolls back display on failure.
- Keep Open/Fresh Link extension-owned. The action retains `webui:activity` status, generation checks,
  one-time link invalidation, widget/notification publication, and server-start rollback.
- Keep invalid settings read-only: Repair is a detail screen, Settings never writes until the file is
  manually repaired and reloaded, and unknown JSON fields/private permissions remain preserved.

## Non-Goals

- Changing the authenticated browser server, one-time bootstrap links, cookies, SSE, request
  deduplication, conversation projection, image pipeline, CSP/assets, or browser UI.
- Exposing settings mutation in RPC/print/JSON, moving file persistence into the kit, or adding a
  generic browser/server screen abstraction.
- Removing `/webui open|settings|status|help|init` or the runtime experimental warning.

## Risks

- `runMenu()` supports RPC settings by default, but pi-webui currently does not. Route the Main
  Settings action by mode and test that RPC cannot toggle it.
- A session can be replaced while a menu, server start, settings save, or init is pending. Revalidate
  generation and closed state after every await before changing state or publishing UI.
- Fresh links are secrets. Never place issued URLs in menu state, tests, errors, status detail, or
  logs; continue exposing them only through the existing widget/notification flow.
- Browser source and generated assets share a reproducibility contract. A TUI-only migration must not
  rewrite committed bundles.

## Plan

- [ ] Add the `<1` kit runtime dependency and lockfile edge to experimental `pi-webui`; verify package
      boundaries, dependency ordering, experimental publishing metadata, and `npm run pack:webui`.
- [ ] Add failing screen/runtime tests for stopped/running server, Manual/Every session, defaults/file/
      invalid sources, repair, image limits, selected-row descriptions, stable cursor, duplicate-safe
      ids, TUI/RPC navigation, print/JSON side effects, owner abort, and session replacement.
- [ ] Replace `createWebUIMenuComponent()`, the TUI/RPC loops, and custom detail component with one
      typed menu definition using the existing session signal/generation; verify cancellation and
      secondary-screen Back preserve selection and never start the server.
- [ ] Route Open through the existing server/link action and activity status; verify success, failure,
      repeated fresh-link issuance, replacement, and shutdown retain secret handling and valid server
      state.
- [ ] Replace the startup `SettingsList` with a kit Settings screen in TUI only, enqueue the complete
      read-modify-write/runtime-publication operation through `settingsSaveQueue`, and verify rapid
      ordering, unknown-field preservation, private atomic writes, failed-save rollback, pending-save
      shutdown, and invalid-file read-only behavior.
- [ ] Preserve direct routes and their mode contracts, especially RPC manual settings and headless
      side-effect-free Open/menu paths; update matching README and compatibility tests without
      expanding the public command surface.
- [ ] Remove only superseded TUI wrappers, then run the package typecheck and `check:web`, root tests,
      `npm run check`, `npm run pack:webui`, an authenticated server/browser asset smoke, and an
      isolated TUI/RPC menu load; verify `npm run build:web --workspace @narumitw/pi-webui -- --check`
      reports no generated-asset drift.
- [ ] Audit command, TUI/RPC, settings concurrency, server/session lifecycle, secret redaction,
      generated assets, experimental package, and verification conventions before archiving.

## Completion Checklist

- [ ] Main, Status, Repair, Help, and TUI Startup Settings use `pi-tui-kit`.
- [ ] RPC settings remain manual/read-only; print/JSON remain side-effect free.
- [ ] Server, links, conversation, settings, invalid-file, assets, direct routes, and experimental
      behavior are unchanged.
- [ ] Focused tests, web/root checks, authenticated/runtime smokes, and pack inspection pass.
