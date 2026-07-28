# pi-subagents pi-tui-kit migration plan

## Goal

Migrate pi-subagents' standard manager, delegation workflow/review, current-agent view, advanced
navigation, completion settings, agent picker, and tool draft to `@narumitw/pi-tui-kit` while
preserving settings locking/publication, unknown fields, reload safety, retained-agent protection,
transactional tool drafts, runtime application, direct routes, and subagent execution lifecycle.

## Context

`extensions/pi-subagents/src/config-ui.ts` contains repeated `SelectList` wrappers, one
`SettingsList`, and an unbounded custom `ToolToggleList`. The no-argument `/subagents` manager is
TUI-only and falls back to status in RPC; direct `settings`, `status`, and `help` routes have their own
mode behavior. Agent tool permissions are selected as a draft and saved once, preserving unavailable
configured tool names and deleting an override only when the draft matches discovered defaults.

The tool catalog can grow without bound, so this migration depends on the bounded multi-select plan.
Confirmations, cross-process settings locks, reload decisions, and subagent domain state remain
extension-owned.

## Architecture

- Complete `2026-07-28_bounded-multiselect-plan.md` before migrating agent tool permissions.
- Define stable screens for Main, Delegation, Delegation Review, Current Agents, Advanced, Completion
  Settings, Runtime Details, Help, Agent Choice, and Agent Tool Draft. Use raw agent/tool names behind
  collision-safe ids and sanitize display only.
- Preserve the current TUI-only no-argument manager: guard before `runMenu()`, show status in RPC, and
  keep print/JSON silent or explicitly reject according to the documented contract. Direct routes
  retain their existing mode behavior.
- Add a session-owned menu controller/generation in the config command registration and abort it on
  replacement/shutdown. Do not tie menu closure to live subagent cancellation.
- Model agent tools as a bounded multi-select with an extension-owned draft and explicit Save/Cancel
  actions. Toggle callbacks update only the draft; Save performs one locked
  `updateAgentToolsSetting()` after re-reading discovery/defaults, and cancellation discards the
  draft.
- Continue using the extension's settings mutation lock and atomic rename protocol. Kit callback
  serialization is UI ordering only and must not be described as cross-process coordination.
- Treat `await ctx.reload()` as terminal: after a confirmed workflow save, use no captured old context
  or runtime state and let the menu owner become stale.

## Non-Goals

- Changing subagent tools, transports, prompts, concurrency/retention limits, agent discovery,
  project trust, execution confirmation, or settings schema/migration.
- Persisting each tool toggle immediately or replacing the cross-process settings protocol with kit
  state.
- Adding tool search, agent editing, or package-specific screen hooks to `pi-tui-kit`.

## Risks

- Immediate kit toggles would violate the current one-save tool draft. Keep a separate draft and make
  Save the only persistence boundary.
- Configured tools may no longer be registered. Preserve them in the draft so a no-op save cannot
  silently erase forward-compatible or temporarily unavailable names.
- Workflow changes can remove live tool surfaces and require reload. Recheck retained agents before
  preview, before save, and immediately before reload.
- Synchronous lock/file operations can throw after the screen has optimistically changed. Convert the
  action to a rejected result, keep the prior runtime value, and surface a sanitized error.

## Plan

- [ ] Complete and archive the bounded multi-select prerequisite; verify large catalogs, descriptions,
      pending rollback, cursor restoration, and existing consumers before changing `pi-subagents`.
- [ ] Add the `<1` kit runtime dependency and lockfile edge; verify `npm run check:boundaries` and
      `npm run pack:subagents` show correct independent runtime metadata.
- [ ] Add failing screen/runtime tests for every manager state and route: all/async-only/blocking-only,
      configured-after-reload, invalid settings, active/retained/closed agents, completion values,
      TUI Back/cursor restoration, RPC status fallback, print/JSON behavior, owner abort, and session
      replacement.
- [ ] Replace Main, Delegation, Review, Current Agents, Advanced, Runtime Details, and Help wrappers
      with typed action/detail screens; preserve exact effect previews, retained-agent guards,
      confirmation, save failure behavior, and terminal `ctx.reload()` handling.
- [ ] Replace the completion `SettingsList` with a kit Settings screen whose action runs the existing
      locked update and runtime application as one ordered operation; verify unknown-field
      preservation, immediate prompt-guidance changes, rollback, malformed-file protection, and
      direct `settings` behavior.
- [ ] Add failing bounded tool-draft tests for many tools, unavailable configured names, default
      restoration, raw control-bearing names, rapid toggles, Save/Cancel, failed locked writes, agent
      rediscovery, disposal, and session replacement.
- [ ] Replace the agent picker and `ToolToggleList` with action and bounded multi-select screens,
      keeping discovery/default comparison and one-shot persistence extension-owned; remove custom
      wrappers only after no-op saves and cancelled drafts prove byte-for-byte settings preservation.
- [ ] Update the README for standard navigation without changing direct routes, then run the package
      typecheck, root tests, `npm run check`, `npm run pack:subagents`, and isolated TUI/RPC load
      smokes with mocked subagents and a synthetic large tool catalog.
- [ ] Audit command, TUI, settings concurrency, reload, retained-agent lifecycle, sanitization,
      package, and verification conventions before archiving.

## Completion Checklist

- [ ] Standard manager, workflow, detail, settings, agent, and tool-draft screens use `pi-tui-kit`.
- [ ] Tool changes remain a cancellable one-save draft with unavailable-name/default preservation.
- [ ] Settings locking, reload safety, runtime values, retained agents, direct routes, and execution
      behavior are unchanged.
- [ ] Prerequisite, focused tests, root checks, pack inspection, and mode/lifecycle smokes pass.
