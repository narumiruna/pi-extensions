## Goal

Add a user-global `defaultPlanTools` setting to `pi-plan-mode` so fresh Plan-mode sessions start with a stable, user-selected tool baseline, while preserving the current built-in defaults, required Plan tools, session-level `/plan tools` overrides, and fail-closed tool classification.

## Context

`pi-plan-mode.json` currently configures only `thinkingLevel`. When a session has no stored `/plan tools` selection, `defaultPlanModeToolNames()` selects the available safe built-ins; an explicit selection is stored in `PlanModeState.selectedToolNames` and restored by tool name. Issue #212 asks for a global baseline that does not need to be reselected in every new session.

This plan is the recommended first of two sequential changes for issue #212. The configurable Git-policy plan should follow it because both changes extend the same settings schema, tests, and README section.

## Architecture

Extend the user-global settings file with an optional property:

```json
{
  "thinkingLevel": "inherit",
  "defaultPlanTools": ["read", "bash", "grep", "find", "ls"]
}
```

- An omitted `defaultPlanTools` keeps today’s available safe-built-in defaults; no settings file is created automatically.
- An explicit empty array is valid and enables only the required `plan_mode_question` and `plan_mode_complete` tools.
- Values must be non-empty tool-name strings and are deduplicated in first-seen order. A wrong type or malformed item invalidates the settings file and uses the existing warning/fallback path.
- At activation, configured names are intersected with currently available tools accepted by `canSelectToolInPlanMode()`. Unknown, unavailable, and blocked names never reach `setActiveTools()`; required Plan tools are still added unconditionally.
- A restored `selectedToolNames` value—including an explicit empty selection—wins over the global default. Legacy `selectedToolKeys` migration also remains higher precedence. Therefore `/plan tools` stays a session-level override.
- Configured non-built-in names retain the selector’s existing user-risk semantics and name/source caveat; a trusted extension overriding the same name is the effective tool Pi exposes.

## Non-Goals

- Do not add a `Save as default` TUI action or write `pi-plan-mode.json` from the extension.
- Do not add project-local defaults or bypass Pi project trust.
- Do not change which tools are classified as read-only, limited, user-opt-in, or blocked.
- Do not alter active tools outside Plan mode or change exact pre-Plan restoration behavior.

## Plan

- [x] Extracted the existing settings-focused tests from `extensions/pi-plan-mode/test/plan-mode.test.ts` into `extensions/pi-plan-mode/test/settings.test.ts` without changing assertions; `npm test` passes 506/506 tests before adding new behavior.
- [x] Added settings tests for omitted, explicit, empty, duplicate, malformed-item, and wrong-type `defaultPlanTools` values in `extensions/pi-plan-mode/test/settings.test.ts`; the new normalization test failed before implementation and now passes.
- [x] Extended `PlanModeSettings` and `normalizePlanModeSettings()` in `extensions/pi-plan-mode/src/settings.ts` with strict, ordered-deduplicated `defaultPlanTools` normalization while preserving existing settings behavior; `npm test` passes 507/507 and the pi-plan-mode workspace typecheck passes.
- [x] Added lifecycle tests proving a fresh session uses the configured baseline, missing configuration keeps current defaults, an empty baseline keeps only required Plan tools, unavailable/blocked names fail closed, and explicit, empty, or legacy restored session selections win; two new default-selection tests failed before runtime integration and all now pass.
- [x] Integrated the configured baseline into `defaultPlanModeToolNames()` without mutating persisted session state or widening blocked tools; exact active-tool tests cover entry, resume, `/plan tools` override, implementation, exit, and session shutdown, and `npm test` passes 512/512.
- [x] Updated `extensions/pi-plan-mode/README.md` with the setting path, precedence, empty-array behavior, unavailable/blocked filtering, non-built-in risk, and a complete JSON example; source/test comparison matches and `just pack-plan-mode` contains the expected 11 package files.
- [x] Reviewed settings reload, dynamic tool availability, overridden built-in names, duplicate names, missing tool metadata, and no-UI startup; added regression tests for reload fallback, effective-source selection, bounded dynamic activation, and fail-closed explicit defaults, with 515/515 tests passing.

## Risks

- Tool identity is name-based in Pi, so an extension can replace a built-in name. Keep the existing source warning explicit and never describe configured non-built-ins as inherently read-only.
- Treating an empty array as “use defaults” would make it impossible to request only the required Plan tools; preserve the distinction between omitted and empty.
- Persisting resolved defaults into `selectedToolNames` would accidentally turn a global baseline into a sticky session override and hide later settings changes; compute defaults without storing them.
- Settings are loaded at `session_start`; tools registered later may not become active until Plan tools are reapplied. Document no dynamic auto-activation guarantee unless testing proves one already exists.

## Completion Checklist

- [x] Fresh Plan-mode sessions honor valid `defaultPlanTools`, while omitted settings preserve current defaults, verified by exact active-tool lifecycle tests in the 515-test suite.
- [x] `/plan tools` and restored legacy selections override the global baseline for their session, verified by resume and selector persistence tests.
- [x] Empty, duplicate, unknown, unavailable, blocked, and malformed values have deterministic fail-closed behavior, verified by settings, reload, and lifecycle tests.
- [x] Required Plan tools remain active and pre-Plan tools are restored exactly on implementation, exit, and shutdown, verified by regression tests.
- [x] User documentation matches the implemented precedence and safety boundaries, verified by README/source/test review and an inspected 11-file `just pack-plan-mode` dry run.
- [x] Repository verification passes with `npm run check` (515/515 tests), targeted Biome checks pass for ignored extension source, and the isolated-agent-dir runtime smoke exposes `--plan`.
