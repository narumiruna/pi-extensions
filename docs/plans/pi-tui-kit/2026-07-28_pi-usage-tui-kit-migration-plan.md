# pi-usage pi-tui-kit migration plan

## Goal

Migrate `/usage`'s current-state action loop and configured-provider selector to
`@narumitw/pi-tui-kit` while preserving runtime-auth validation, model/account stability checks,
provider-specific semantics, bounded concurrency, partial all-provider results, statusline ownership,
cache isolation, and cancellable network loaders.

## Context

`extensions/pi-usage/src/usage.ts` first queries a stable current provider, then repeatedly displays
Refresh, View another, View all, and Close through `ctx.ui.select()`. Another-provider selection is a
second selector. Network operations use `runMenuOperation()` and active controllers with stronger
model/account revalidation than a generic menu can provide.

## Architecture

Keep the initial stable-current query and every provider query in extension-owned cancellable
operations. After initial state exists, run a typed Main action screen whose lines render the current
`visibleStates`; add a provider-choice action screen with stable provider ids. Actions update
menu-local visible state only after the existing model/account revalidation succeeds, then return
`stay`, `back`, or `to` so the screen refreshes without losing cursor position.

Pass the invocation controller signal to `runMenu()` and define `isCurrent()` from that signal,
session activity, and the captured status generation. Do not wrap query actions in a second generic
busy loader. RPC remains interactive through dialogs; print/JSON must reject observably instead of
relying on no-op notification output. `/usage` continues to reject all arguments.

## Non-Goals

- Changing provider endpoints, auth origin checks, usage normalization, cache/backoff, concurrency,
  status formatting, or supported providers.
- Adding direct refresh/provider/all routes or persisting usage state.
- Moving network/query policy into `pi-tui-kit`.

## Risks

- The selected model/account can change during any query. Keep `outcomeStillCurrent()` authoritative
  and discard results before mutating visible/menu/status state.
- A generic state loader must not trigger unintended network calls on each navigation; only explicit
  query actions contact providers.
- Partial all-provider failures must remain visible and must not overwrite current-provider status.

## Plan

- [ ] Add the `<1` kit dependency and lockfile edge; verify package boundaries and pack metadata.
- [ ] Add failing tests for initial current state, refresh, another-provider navigation, all-provider
      partial results, cursor restoration, stable ids, RPC, no-UI rejection, cancellation, model/auth
      changes, and session shutdown.
- [ ] Introduce typed Main/provider screens backed by menu-local visible state and the existing
      invocation controller, replacing selector loops without moving query work into `getState()`;
      verify focused menu tests pass.
- [ ] Route actions through existing cancellable query/revalidation helpers and retain status
      publication only for the stable current provider; verify cache, auth-origin, concurrency,
      partial-failure, and status lifecycle tests pass.
- [ ] Update README only for standard navigation/mode wording, then run package/root checks, root
      tests, `npm run pack:usage`, and an isolated RPC smoke with mocked provider endpoints.
- [ ] Audit menu, cancellation, auth/redaction, status, command, package, and verification conventions
      before archiving.

## Completion Checklist

- [ ] Standard usage and provider screens use `pi-tui-kit` with no implicit network-on-navigation.
- [ ] Auth/model stability, cache, provider semantics, partial results, and current-only status remain
      unchanged.
- [ ] TUI/RPC/no-UI, cancellation, disposal, replacement, and shutdown behavior is tested.
- [ ] Checks, tests, pack inspection, and runtime smoke pass.
