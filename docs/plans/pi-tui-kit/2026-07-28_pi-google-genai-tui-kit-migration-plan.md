# pi-google-genai pi-tui-kit migration plan

## Goal

Replace `/google-genai tools`' custom TUI and repeated RPC selector with the standard
`pi-tui-kit` multi-select screen while preserving active-tool ownership, immediate ordered
persistence, failed-save rollback, credential preservation, direct enable/disable routes, and session
staleness guards.

## Context

`extensions/pi-google-genai/src/google-genai.ts` implements the same tool rows twice: a custom TUI
component and an RPC `ctx.ui.select()` loop. It optimistically toggles three tools, supports Enable
all/Disable all/Done, serializes saves, and restores Pi's current Google tool set when persistence
fails. The extension has a session generation but no action owner signal.

## Architecture

Use one `multiSelect` screen with tool ids as raw action payloads and explicit Enable all, Disable all,
and Done action rows. The screen state derives from `currentGoogleTools(pi)`; each toggle or bulk
action calls the existing `transactGoogleToolSelection()` and `saveToolSelection()` protocol.
`pi-tui-kit` owns callback serialization and visual rollback; the extension remains authoritative for
Pi's global active tool set, preserving other extensions' tools and credential-bearing config fields.

Add a session menu controller or equivalent abortable owner alongside `sessionGeneration`, and pass
both signal and `isCurrent`. Keep `/google-genai init`, status/config/help, enable, and disable outside
this migration. Print/JSON retain an observable unsupported result; RPC uses the same declarative
screen rather than duplicate labels.

## Non-Goals

- Adding a new main `/google-genai` manager or changing direct commands.
- Changing API-key precedence, config schema/migration, Google requests, tool definitions, or outputs.
- Moving init prompts or provider auth into the kit.

## Risks

- Pi tools are a shared global list; rollback must restore only this extension's intended subset
  without deleting sibling tools.
- Rapid toggles and bulk actions must publish in invocation order and ignore stale rollback from an
  older revision.

## Plan

- [ ] Add the `<1` kit dependency and lockfile edge; verify package boundaries and runtime resolution.
- [ ] Add failing multi-select tests for initial selection, stable cursor, toggle, rapid toggle,
      Enable all, Disable all, Done, persistence ordering, rejected rollback, RPC adaptation, owner
      abort, and session replacement.
- [ ] Replace both selector implementations with one typed multi-select definition and session-owned
      signal, delegating persistence/runtime application to existing transaction helpers; verify
      focused tool-selection tests pass.
- [ ] Remove superseded render/clip/row dispatch code only after proving active tool preservation,
      unknown-field/credential preservation, malformed settings, and enable/disable direct routes.
- [ ] Update README wording only if standard key/Back behavior differs, then run package/root checks,
      root tests, `npm run pack:google-genai`, and an isolated RPC selector smoke without live Google
      traffic.
- [ ] Audit menu, settings, shared-tool ownership, lifecycle, credential redaction, and package
      conventions before archiving.

## Completion Checklist

- [ ] TUI and RPC tool selection share one `pi-tui-kit` multi-select model.
- [ ] Ordered saves, rollback, sibling-tool preservation, credentials, and direct routes are unchanged.
- [ ] Cancellation/disposal/session replacement cannot apply stale tool state.
- [ ] Tests, checks, pack inspection, and runtime smoke pass.
