## Goal

Resolve [issue #335](https://github.com/narumiruna/pi-extensions/issues/335) with an opt-in, Plan-mode-only allowlist for subagent role names. A configured Plan session must reject disallowed blocking and detached subagent launches before execution, while `pi-plan-mode` and `pi-subagents` remain independently installable and normal non-Plan sessions remain unchanged.

## Context

`defaultPlanTools` can expose the extension-owned `subagent` tool during Plan mode, but `extensions/pi-plan-mode/src/plan-mode.ts` currently guards only `update_plan`, blocked built-ins, and the canonical `bash` name. It does not inspect which role an enabled delegation tool will launch.

The current `pi-subagents` request surface selects roles at `agent`, `tasks[].agent`, `chain[].agent`, and `aggregator.agent` for blocking calls (`extensions/pi-subagents/src/params.ts`), plus `agent` for `subagent_spawn` (`extensions/pi-subagents/src/stateful.ts`). `pi-subagents` owns role discovery and execution, while Plan mode owns whether a launch is acceptable in a Plan session. Pi has no shared capability-policy API yet, so this change is a bounded name-based integration rather than capability inheritance.

## Architecture

Extend the optional user settings file `$PI_CODING_AGENT_DIR/pi-plan-mode.json` with:

```json
{
  "defaultPlanTools": ["read", "bash", "grep", "find", "ls", "subagent"],
  "allowedPlanSubagents": ["plan-scout", "plan-researcher", "plan-reviewer"]
}
```

- Omitted `allowedPlanSubagents` preserves current behavior and does not restrict subagent roles.
- An explicit empty array denies every covered subagent launch while Plan mode is active.
- Entries are exact, case-sensitive, non-empty role-name strings, deduplicated in first-seen order. Malformed values use the existing invalid-settings warning and fallback behavior.
- The policy is enforced from `pi-plan-mode`'s existing `tool_call` hook only while `state.enabled` is true, independently of whether the launch tool came from `defaultPlanTools` or a session-level `/plan tools` selection.
- A package-local policy helper will recognize `subagent` and `subagent_spawn` by tool name without importing `pi-subagents`. It will collect every role-bearing field in the current public call shapes, reject the whole call if any role is disallowed, and fail closed when a covered launch payload does not provide a complete non-empty role set. Full mode/schema validation remains owned by `pi-subagents`.
- The block reason will identify disallowed roles and the configured allowed roles so the model can retry with a permitted role. Returning `{ block: true, reason }` prevents the launch tool's executor from starting a child; it does not terminate the Plan turn.
- When `pi-subagents` is absent, no covered tool call exists and the setting is inert. No dependency, package import, event-bus requirement, or settings ownership is added between the extensions.

## Non-Goals

- Do not inspect or prove the effective tools, permissions, source, or mutability of an allowed role; the allowlist is name-based defense in depth, not a sandbox.
- Do not add RPC, a core capability protocol, a bridge package, or a dependency from `pi-plan-mode` to `pi-subagents`.
- Do not change `pi-subagents` role discovery, tool schemas, execution, or project-agent confirmation behavior.
- Do not authorize or classify `subagent_send` by retained agent ID; it does not launch a named role and Plan mode cannot resolve its effective role without a shared runtime contract.
- Do not change extension/custom-tool defaults, `/plan tools` persistence, or tool restoration outside Plan mode.

## Risks

- Role names can resolve to changed or same-name user/project definitions, so an allowed name can later become write-capable. Document that users must keep allowed role definitions read-only and that this setting does not validate capabilities.
- Tool names and argument paths are an implicit cross-extension protocol. Keep parsing isolated and tested; malformed covered launch shapes fail closed, but renamed/new delegation tools require a follow-up integration update.
- Omitted or invalid allowlist configuration does not establish the restriction. Preserve backward compatibility, surface the existing settings warning, and document exact empty-versus-omitted semantics.
- Existing retained agents can be addressed through lifecycle tools such as `subagent_send`; this bounded issue does not claim to make every custom delegation workflow read-only.

## Plan

- [x] Add focused failing cases to `extensions/pi-plan-mode/test/settings.test.ts` for omitted, populated, duplicate, empty, whitespace-only, non-array, and mixed-type `allowedPlanSubagents`; `npm test` produced the intended missing-property assertion failure before implementation (with two unrelated environment/timing failures elsewhere in the suite).
- [x] Add a new focused policy test module under `extensions/pi-plan-mode/test/` covering allowed and disallowed single, parallel, chain, aggregator, and `subagent_spawn` roles; `npm test` produced the intended seven policy failures from the no-op scaffold, including disallowed, mixed, malformed, and empty-allowlist cases.
- [x] Extend `PlanModeSettings` and `normalizePlanModeSettings()` in `extensions/pi-plan-mode/src/settings.ts` with strict ordered-deduplicated `allowedPlanSubagents` normalization while preserving omitted-versus-empty semantics and existing settings loading/migration behavior; all 5 focused settings tests pass.
- [x] Add a cohesive package-local subagent policy helper under `extensions/pi-plan-mode/src/` that recognizes only `subagent` and `subagent_spawn`, extracts all current role positions without importing another extension, rejects malformed covered role payloads, and returns deterministic disallowed-role details; all 7 focused policy tests pass and the source/package search reports no `pi-subagents` reference.
- [x] Wire the helper into the active `tool_call` path in `extensions/pi-plan-mode/src/plan-mode.ts` before launch execution; 78 focused Plan-mode tests and all 1,067 repository tests pass for inactive, omitted, configured, empty, manual-selection, missing-extension, malformed-call, and reload behavior.
- [x] Update `extensions/pi-plan-mode/README.md` with the complete setting example, precedence and reload behavior, omitted/empty semantics, covered blocking/detached call shapes, independent-install behavior, and the name/source/capability limitation; source/test/documentation search confirms every documented field and boundary matches the implementation.
- [x] Run the release-equivalent checks `npm run check` and `just pack-plan-mode`, inspect the dry-run package for the new source helper and unchanged `src/plan-mode.ts` entrypoint, and review the final diff to confirm no `pi-subagents` package or dependency changed; `NODE_OPTIONS=--test-isolation=none npm run check` passes all 1,067 tests after the default parallel runner repeatedly exposed one unrelated timer-sensitive `pi-subagents` test, and the 13-file package preview includes `src/subagent-policy.ts`.

## Completion Checklist

- [x] Active Plan mode blocks every disallowed role in current `subagent` single/parallel/chain/fan-in calls and `subagent_spawn` calls before execution, proven by focused hook and policy tests.
- [x] Allowed roles pass unchanged, any mixed call is rejected as a whole, and malformed covered launch payloads fail closed, proven by exact test assertions.
- [x] Omitted settings preserve compatibility, an empty allowlist denies all covered launches, inactive Plan mode is unaffected, and absence of `pi-subagents` causes no error or behavior change, proven by lifecycle tests.
- [x] `pi-plan-mode` remains independently installable with no source import, package dependency, or required runtime service from `pi-subagents`, proven by boundary checks and package inspection.
- [x] README documentation clearly describes the name-based safety boundary and does not claim capability or sandbox enforcement, verified against source and tests.
- [x] `npm run check` and `just pack-plan-mode` pass with the intended publish contents and no unrelated changes.
