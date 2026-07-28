# pi-plan-mode pi-tui-kit migration plan

## Goal

Migrate pi-plan-mode's active-mode manager, settled proposed-plan menu, and persistent tool selector to
`@narumitw/pi-tui-kit` while preserving tool-policy enforcement, active-tool restoration, completed
plan ownership, lifecycle delivery, session persistence, thinking-level ownership, direct command
routes, and question-tool dialogs.

## Context

`extensions/pi-plan-mode/src/plan-mode.ts` uses `ctx.ui.select()` for the active Plan menu, the
`agent_settled` ready menu, and an RPC fallback for tool selection. `selector-ui.ts` implements the
TUI tool selector itself. Both command and lifecycle menus receive `ExtensionContext`, and the tool
catalog can grow with every registered extension. Blocked built-ins remain visible and explained but
must not toggle.

This migration therefore depends on the shared plans for generic `ExtensionContext` menus, bounded
multi-select rendering with selected descriptions, and disabled multi-select rows. The
`plan_mode_question` select/editor flow is a one-off model-driven prompt and remains extension-owned.

## Architecture

- Complete `2026-07-28_extension-context-plan.md`,
  `2026-07-28_bounded-multiselect-plan.md`, and
  `2026-07-28_disabled-multiselect-items-plan.md` before changing this consumer.
- Define separate typed entry definitions for the command-owned active-mode menu and the
  lifecycle-owned ready menu, sharing extension-owned actions without adding a dynamic-start feature
  to the kit.
- Add a session menu controller/generation rotated on `session_start` and aborted on
  `session_shutdown`. Combine it with the ready-intent nonce and completed-plan identity in every
  lifecycle `isCurrent()` guard.
- Model the tool catalog as one bounded `multiSelect` screen. Use raw tool names as stable ids,
  sanitized name/policy/source text for display, selected descriptions for source/risk details, and
  disabled rows for policy-blocked built-ins. Remove manual pagination only after equivalent TUI and
  RPC coverage passes.
- Keep `pi.getAllTools()`, `pi.setActiveTools()`, `appendEntry()`, and the Plan state as the authority.
  A toggle revalidates the current catalog and policy at activation time, persists selected names,
  and preserves required completion/question tools plus every restoration rule.
- Preserve RPC adaptation for Plan manager/tool menus. Define and test an observable print/JSON
  status or rejection rather than relying on no-op notifications; retain all documented direct
  `/plan` routes and completions.

## Non-Goals

- Changing Plan-mode prompts, completion/question tool schemas, safe shell/subagent policy, settings
  file format, thinking levels, proposed-plan parsing, or implementation handoff.
- Moving question-tool selects/editors, transcript messages, statuses, or widgets into the kit.
- Adding search, manual pagination, or Plan-specific tool policy hooks to `pi-tui-kit`.

## Risks

- A ready menu launched from `agent_settled` can outlive its plan, session, or extension context.
  Require all three ownership checks before and after every await.
- Tool names are not globally unique by provenance, but Pi activates tools by name. Keep the current
  name-based domain semantics while ensuring labels never become lookup keys.
- The active tool list is shared with other extensions. Toggling and exiting must preserve the exact
  pre-Plan set and never restore stale tools into a replacement session.
- Large catalogs can change while open. Re-read policy and availability at activation time, retain
  cursor identity when possible, and ignore removed rows without broadening access.

## Plan

- [ ] Complete and archive the three prerequisite kit plans; verify package declarations expose the
      `ExtensionContext` generic, bounded viewport/descriptions, and disabled multi-select rows before
      adding the consumer dependency.
- [ ] Add the `<1` kit runtime dependency and lockfile edge to `pi-plan-mode`; verify package
      boundaries and `npm run pack:plan-mode` resolve the built package independently.
- [ ] Add failing screen/runtime tests for active planning with/without a completed plan, ready-menu
      settlement, duplicate/replacement completions, TUI/RPC navigation, print/JSON behavior, owner
      abort, disposal, stale context, and direct-route compatibility.
- [ ] Replace `showPlanMenu()` and `showPlanReadyMenu()` with typed command/lifecycle menu definitions
      using the new context generic and session owner; verify implementation, exit, stay, show,
      finalize, and failed-handoff paths preserve state, tools, status, widget, and one-time delivery.
- [ ] Add failing large-catalog tests for first/middle/last viewport positions, injected paging,
      selected policy/source descriptions, blocked rows, duplicate-looking labels, catalog refresh,
      RPC parity, rapid toggles, and restoration after cancellation/session replacement.
- [ ] Replace `showPersistentSelector()` and `showDialogToolSelector()` with one bounded multi-select;
      revalidate each raw tool name and policy before `setActiveTools()`, preserve required Plan tools,
      persist selected names in invocation order, and verify blocked tools cannot activate.
- [ ] Remove the superseded selector and manual page code after all policy, default-tool, legacy-key,
      settings, thinking-level, completion, and session-restore tests pass unchanged; retain
      `plan_mode_question` dialogs as one-off UI.
- [ ] Update the README for standard tool-selector navigation and explicit mode behavior, then run the
      package typecheck, root tests, `npm run check`, `npm run pack:plan-mode`, and isolated TUI/RPC
      load smokes with a synthetic large tool catalog.
- [ ] Audit command, TUI/RPC, lifecycle settlement, cancellation/disposal, shared-tool ownership,
      persistence, package, and verification conventions before archiving.

## Completion Checklist

- [ ] Active and ready Plan menus use context-safe `pi-tui-kit` action screens.
- [ ] The tool catalog uses one bounded, descriptive, disabled-aware multi-select in TUI and RPC.
- [ ] Plan completion ownership, tool policy/restoration, persisted state, thinking level, direct
      routes, question prompts, and implementation handoff are unchanged.
- [ ] Prerequisites, focused tests, root checks, pack inspection, and lifecycle/runtime smokes pass.
