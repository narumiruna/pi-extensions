# pi-tui-kit ExtensionContext support plan

## Goal

Generalize `@narumitw/pi-tui-kit` so standard menus can be launched safely from Pi lifecycle handlers
that receive `ExtensionContext`, while preserving the richer `ExtensionCommandContext` type for
command-owned menus and keeping all existing consumers source-compatible. This unblocks migration of
Plan mode's `agent_settled` ready menu without weakening context typing or exposing command-only
session actions where Pi does not provide them.

## Context

`runMenu()`, `RunMenuOptions`, `MenuActionContext`, and the menu definition types currently hard-code
`ExtensionCommandContext`. The runtime itself uses only common context capabilities such as `mode`,
`hasUI`, and `ui`; it does not call `waitForIdle()`, `reload()`, or session replacement actions.
`pi-plan-mode` opens a standard three-action ready menu from `agent_settled`, whose callback receives
`ExtensionContext`, so a cast or duplicate selector would be required under the current API.

Simply replacing every command context type with `ExtensionContext` would remove legitimate
command-only typing from existing and future command menus. The API therefore needs a context generic,
not a broad cast or a global type downgrade.

## Architecture

- Add a trailing context generic constrained to `ExtensionContext` and defaulted to
  `ExtensionCommandContext` on `MenuDefinition`, `MenuActionContext`, `MenuActionHandler`, screen
  factory support types where needed, `RunMenuOptions`, `defineMenu()`, and `runMenu()`.
- Preserve existing three-generic calls such as `defineMenu<State, Screen, Action>()`; the default
  must keep action `ctx` typed as `ExtensionCommandContext`.
- Allow lifecycle consumers to declare `ExtensionContext` explicitly and ensure `runMenu()` accepts
  only a compatible context/definition/options combination.
- Keep the emitted runtime implementation behavior unchanged: TUI custom screens, RPC adaptation,
  unsupported modes, cancellation, stale checks, pending-work draining, and error reporting remain
  identical.
- Do not add command-only methods to a lifecycle context through structural casts or `as` assertions.

## Non-Goals

- Adding lifecycle hooks, session-generation ownership, or context storage to the library.
- Letting the library capture and reuse contexts after replacement.
- Adding Plan-mode-specific screens, callbacks, or state.
- Changing menu visuals, navigation, settings semantics, or package API version behavior beyond the
  backwards-compatible context generic.

## Risks

- Type inference can widen all consumers to `ExtensionContext` and silently hide command-only methods.
  Lock the default and inference behavior with compile-time usage fixtures.
- Internal helper generics can become difficult to maintain. Keep the context generic at public and
  action/state-loader boundaries and avoid duplicating it on screen data that never contains context.
- Runtime tests alone cannot prove context typing. Compile README-style fixtures and negative
  `@ts-expect-error` cases through the package typecheck.

## Plan

- [ ] Add failing compile-time fixtures under `packages/pi-tui-kit/test/` proving an
      `ExtensionContext` menu currently cannot be passed to `runMenu()`, existing three-generic command
      definitions retain command-only `ctx` methods, and incompatible context definitions are rejected;
      verify `npm --workspace @narumitw/pi-tui-kit run typecheck` fails only on the missing generic API.
- [ ] Introduce the backwards-compatible context generic in `src/types.ts`, `src/model.ts`, and
      `src/runtime.ts` without casts that add command-only capabilities; verify existing Chrome
      DevTools and Firecrawl source still typechecks unchanged and the new fixtures pass.
- [ ] Add runtime tests that launch equivalent TUI and RPC menus with an `ExtensionContext`, abort the
      owner signal during state loading and action execution, dispose an open screen, and reject stale
      continuations; verify results match the existing command-context contract.
- [ ] Update `packages/pi-tui-kit/README.md` with one lifecycle-handler example and an ownership warning
      that consumers must pass a session signal and `isCurrent()` guard and must never retain a replaced
      context.
- [ ] Run the package check, root tests, root CI-equivalent check, and `just pack-tui-kit`; inspect
      generated declarations and tarball contents, then typecheck the two existing consumers and the
      planned Plan-mode usage fixture.
- [ ] Audit the final diff against Pi TUI lifecycle, cancellation, disposal, mode, package, and public
      API conventions; record any inference or compatibility deviation before archiving the plan.

## Completion Checklist

- [ ] Existing command-menu source compiles unchanged and keeps `ExtensionCommandContext` action typing.
- [ ] Lifecycle menus can opt into `ExtensionContext` without casts or command-only methods.
- [ ] TUI, RPC, unsupported-mode, cancellation, disposal, stale-action, and error behavior is unchanged.
- [ ] Generated declarations, README examples, package checks, root checks, and pack inspection pass.
- [ ] No Plan-mode-specific policy or consumer state was added to `pi-tui-kit`.
