# pi-subagents command manager plan

## Goal

Make `/subagents` the interactive, current-session-first manager for pi-subagents while retaining the required direct `/subagents settings|status|help` entrypoints and the documented `/subagents:config` and `/subagents:agents` compatibility commands.

## Context

- `docs/extension-settings.md` explicitly requires the primary command to expose `settings`, `status`, and `help`, so those subcommands are already aligned with repository settings conventions and must remain predictable direct routes.
- `MEMORY.md` additionally prefers one interactive manager that shows current state plus next actions, makes cross-context effects explicit, and avoids hidden argument behavior.
- `extensions/pi-subagents/src/config-ui.ts` currently routes an argument-free `/subagents` invocation to help instead of a manager, while tool settings and current-session agent inspection remain split across `/subagents:config` and `/subagents:agents`.
- Pi supports custom component screens only in TUI mode. RPC can receive `ctx.ui.notify()` output, while JSON and print modes must not receive ad hoc protocol-breaking output.

## Architecture

- Keep `extensions/pi-subagents/src/config-ui.ts` responsible for the primary command router, interactive manager, settings screen, help/status presentation, and navigation between those screens.
- Extend the controller returned by `registerStatefulSubagents()` with a read-only runtime snapshot and narrowly scoped current-session agent actions; do not expose the mutable `AgentRegistry` to the UI module.
- Distinguish state in every presentation:
  - **Current session:** lifecycle availability, initialized state, configured transport in use, runtime completion delivery, and active/retained agent counts.
  - **User settings:** canonical settings path, configured completion delivery, source/default status, and the fact that changes persist for future sessions while applying immediately to the current runtime.
- Use `SelectList` for the manager/action menu and retain `SettingsList` for editable enum settings. Recreate nested components when navigating back rather than reusing disposed TUI instances.
- Preserve direct command routing and compatibility aliases by having every entrypoint call shared presentation/action functions instead of maintaining separate behavior.

## Non-Goals

- Do not remove or rename `/subagents settings`, `/subagents status`, `/subagents help`, `/subagents:config`, or `/subagents:agents` in this change.
- Do not change the `pi-subagents.json` schema, precedence, migration, completion-delivery semantics, transport behavior, lifecycle tools, persistence format, or agent execution behavior.
- Do not add native transcript switching or a new agent transcript UI.
- Do not turn every advanced JSON-only stateful limit into an interactive setting.

## Risks

- A manager opened before `session_start`, after `session_shutdown`, or with `stateful.enabled: false` could read absent runtime state; the controller snapshot must represent these cases without throwing or retaining stale registry references.
- Nested custom screens can reuse disposed components or stale settings snapshots; each screen must load fresh state and create fresh components on entry.
- A label that does not distinguish current-session actions from user-global settings could cause unintended cross-session changes; scope must be visible before selection and in save notifications.
- Consolidating compatibility commands could accidentally change their existing argument behavior; focused routing tests must lock down `list`, `clear`, tool configuration, and unknown-argument handling.

## Rollback / Recovery

- The change introduces no settings or persistence migration. If the manager UI regresses, restore argument-free `/subagents` routing to help while leaving the direct subcommands and compatibility aliases operational.
- Keep runtime snapshot access read-only and controller-owned so reverting the UI does not require registry or persisted-state recovery.

## Plan

- [x] Add focused command-contract tests in `extensions/pi-subagents/test/subagents.test.ts` and, where runtime registry state is required, `extensions/pi-subagents/test/orchestration.test.ts` for an argument-free TUI manager, unchanged `settings|status|help` autocomplete/direct routing, explicit current-session versus user-setting labels, disabled/uninitialized/shutdown snapshots, RPC notification fallback, JSON/print no-custom-UI behavior, and compatibility alias routing; the first test compile failed because the runtime controller methods were absent, then the manager test failed because bare `/subagents` opened no custom UI, proving the intended red state.
- [x] Extend the controller boundary in `extensions/pi-subagents/src/stateful.ts` with a copied runtime-status snapshot and shared list/clear operations that safely report enabled, initialized, transport, runtime completion delivery, active count, and retained count without exposing `AgentRegistry`; focused tests cover default-on, disabled, pre-start, active, settled, cleared, and shutdown states and pass in the final 93-test package run.
- [x] Refactor `extensions/pi-subagents/src/config-ui.ts` so argument-free `/subagents` opens a fresh `SelectList` manager in TUI mode with a concise current-session summary, the canonical user-settings path/source, and actions for completion settings, agent tool settings, current-session agents, status, and help; mock-TUI tests verify navigation, Escape/back behavior, settings and current-agent action dispatch, 52-column rendering, and fresh manager instances after nested screens.
- [x] Consolidate settings, tool configuration, status/help, and current-session agent inspection into shared functions used by both the manager and the direct or compatibility commands; direct and compatibility routes remain registered, exact subcommands bypass the manager, and unknown or extra arguments now produce explicit warnings in focused tests.
- [x] Make scope explicit in `extensions/pi-subagents/src/config-ui.ts`: completion delivery is labeled as a user setting that persists for future sessions and applies immediately now, agent inspection/clear is labeled current-session-only, and status separates configured values/path/source from runtime/lifecycle/count values; existing and new tests cover save success, rollback, malformed settings, disabled stateful mode, RPC, JSON, and print behavior.
- [x] Update `extensions/pi-subagents/README.md`, `docs/implementation-notes/pi-subagents-capability-matrix.md`, and `docs/implementation-notes/pi-subagents-stateful-runtime.md` so `/subagents` is the primary manager, direct and compatibility routes are explicit, and TUI versus RPC/JSON/print behavior and setting scope are documented; targeted searches find no stale claim that bare `/subagents` only shows help.
- [x] Run formatting only on intended files, `git diff --check`, the focused compiled pi-subagents tests with canonicalized `TMPDIR`, `npm run typecheck --workspace @narumitw/pi-subagents`, `npm run check`, and `just pack-subagents`; 93 focused tests and all 1,057 repository tests pass, package typecheck passes, the dry run contains the expected 22 files, and pseudo-terminal local Pi smokes pass for manager/direct/compatibility routes, save application, Escape/back navigation, and disabled stateful mode (`FINAL_TUI_SMOKE_OK`, `FINAL_DISABLED_TUI_SMOKE_OK`).

## Completion Checklist

- [x] Bare `/subagents` opens one interactive manager in TUI mode and presents current state plus actionable next steps.
- [x] `/subagents settings`, `/subagents status`, and `/subagents help` remain documented, autocomplete-enabled, direct, and behaviorally tested.
- [x] `/subagents:config` and `/subagents:agents list|clear` remain compatible while sharing the manager's underlying actions.
- [x] Current-session state and user-global persisted settings are visibly distinguished before mutations occur.
- [x] Disabled, uninitialized, shutdown, malformed-settings, save-failure, RPC, JSON, and print-mode paths are safe and covered.
- [x] Focused tests, repository checks, package typecheck, package dry run, and local TUI smoke all pass with recorded evidence.
