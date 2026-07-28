# pi-accounts pi-tui-kit migration plan

## Goal

Migrate the argument-free `/accounts` manager and its provider/account selection screens to
`@narumitw/pi-tui-kit` while preserving provider-scoped OAuth storage, active-account switching,
default Pi login restoration, exact removal/replacement confirmations, runtime-auth fail-closed
behavior, and the documented ignored-argument compatibility route.

## Context

`extensions/pi-accounts/src/accounts.ts` currently composes the main account summary, provider
selection, account switching, and account removal through nested `ctx.ui.select()` calls. OAuth name
input and provider login interactions are specialized dialogs and remain extension-owned. The package
has no menu-owned session abort controller; auth coordinators already have separate lifecycle
invalidation that must not be conflated with UI ownership.

## Architecture

Define stable screens for Main, provider choice, account choice, and removal choice. Load provider
state whenever a screen is entered, keep raw provider/account names behind stable ids, and use the
current model only to order actions and explain context. Action handlers re-read the selected
provider/account after every dialog and before mutation.

Add a menu-owned controller/generation that is replaced on `session_start` and aborted on
`session_shutdown`; pass both its signal and current-generation predicate to `runMenu()`. Login keeps
Pi's existing input/OAuth interaction, replacement confirmation, and model-onboarding behavior.
Removal keeps its exact confirmation and restores only the affected provider's default login.

TUI uses standard action screens and RPC uses the kit dialog adapter. Print/JSON must reject
observably rather than relying on `notify()` when `hasUI` is false. Extra `/accounts` text remains
ignored because that compatibility behavior is explicitly documented and tested.

## Non-Goals

- Changing credential files, migration, permissions, provider adapters, refresh, overlays, or model
  filtering.
- Adding account subcommands, automation routes, settings, or API-key profiles.
- Moving OAuth prompts or destructive confirmations into the library.

## Risks

- Display labels can collide or contain special property names; use stable ids plus own-property
  lookups and never map a result back by sanitized label.
- A provider/account can change during OAuth or confirmation; retain current generation checks and
  re-read before writes/runtime overlays.
- Closing a menu must not invalidate auth coordinators that are still session-owned.

## Plan

- [ ] Add the `<1` `@narumitw/pi-tui-kit` runtime dependency and intended lockfile edge; verify
      package boundaries and production dependency resolution.
- [ ] Add failing tests for declarative empty/configured Main screens, current-provider ordering,
      provider/account navigation, Back/cursor restoration, duplicate-safe ids, TUI/RPC behavior,
      no-UI rejection, and session cancellation; verify the red run fails on the legacy selectors.
- [ ] Introduce a typed account menu definition and session-owned menu controller, then replace main,
      provider, switch, and removal selectors with `runMenu()` screens while retaining raw domain
      identity and state reloads; verify focused menu tests pass.
- [ ] Route login, OAuth interaction, replacement, switching, and removal actions to the existing
      domain functions, revalidating generation and latest storage after every await; verify existing
      provider independence, default restoration, fail-closed auth, stale login, and removal tests pass.
- [ ] Update tests that assert selector call order to assert resolved screens and runtime transitions;
      retain direct OAuth/dialog tests and add disposal/shutdown coverage proving no stale menu callback
      mutates credentials or runtime providers.
- [ ] Update the README only for standard navigation/mode wording, then run the package check, root
      tests, root check, `npm run pack:accounts`, and an isolated RPC load/menu smoke.
- [ ] Audit command, TUI, lifecycle, credential, redaction, package, and verification conventions and
      record any compatibility deviation before archiving the plan.

## Completion Checklist

- [ ] All standard account manager screens use `pi-tui-kit`; OAuth and confirmations remain owned by
      `pi-accounts`.
- [ ] Provider/account identities, credentials, migration, model filtering, and fail-closed behavior
      are unchanged.
- [ ] TUI, RPC, print/JSON, cancellation, disposal, replacement, and shutdown paths are covered.
- [ ] Focused tests, package/root checks, pack inspection, and runtime smoke pass.
