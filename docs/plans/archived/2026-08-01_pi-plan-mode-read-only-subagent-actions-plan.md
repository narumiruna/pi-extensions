## Goal

Resolve [issue #480](https://github.com/narumiruna/pi-extensions/issues/480) so a configured
`allowedPlanSubagents` allowlist continues to guard actual child launches while permitting verified
read-only management calls handled by the `pi-subagents` tool.

## Context

The current `tool_call` hook passes every call named `subagent` to
`enforcePlanSubagentAllowlist()`. That helper searches only launch-role fields (`agent`,
`tasks[].agent`, `chain[].agent`, and `aggregator.agent`) and fails closed when none are present.
Consequently, a valid read-only call such as `{ "action": "list" }` is rejected before
`pi-subagents` receives it. Calls such as `get` and filtered `models` are also misclassified because
their `agent` field names an inspection target rather than a role to launch.

A live isolated reproduction with the npm latest releases on 2026-08-01—Pi `0.83.0`,
`@narumitw/pi-plan-mode` `0.41.0`, and `pi-subagents` `0.38.0`—produced an `isError: true`
`tool_execution_end` for `{ "action": "list" }`. Omitting `allowedPlanSubagents` let the same call
return the executable-agent list.

Touched areas are the Plan-mode `tool_call` policy, the documented behavior of the existing
`allowedPlanSubagents` setting, deterministic policy/lifecycle tests, and a real package-integration
smoke. No settings schema, persistence, UI, asynchronous flow, lifecycle resource, or external
`pi-subagents` package code needs to change.

## Architecture

Keep policy ownership in `extensions/pi-plan-mode/src/subagent-policy.ts`; do not import or depend on
`pi-subagents`. Before extracting launch roles from a `subagent` call, classify a string `action`
against a small package-local set whose read-only behavior is verified from `pi-subagents@latest`.
The expected current inspection-only set is:

- `list`, `get`, `models`, `status`, and `doctor`;
- `watchdog.status`, `watchdog.check`, and `watchdog.recommend-model`;
- `schedule-list` and `schedule-status`.

Calls with no management action remain launch-shaped and retain the existing exact, case-sensitive
role checks. Execution aliases accepted by `pi-subagents` (`single`, `parallel`, and `tasks`) must
also retain launch checks when they reach the hook. `subagent_spawn` remains launch-only. Unknown,
malformed, mutating, schedule-creation/cancellation, and child-control actions must not gain a bypass
merely because an `action` field exists; keep them fail-closed with a deterministic explanation. This preserves the
independent-install boundary while making the implicit cross-extension protocol explicit and tested.

## Non-Goals

- Do not change the `allowedPlanSubagents` file format, normalization, precedence, or reload behavior.
- Do not modify `pi-subagents`, add it as a dependency, or generalize this into a shared capability
  protocol.
- Do not enable mutating management or control actions such as `create`, `update`, `delete`,
  `schedule`, `resume`, `steer`, or `append-step` in Plan mode through this fix.
- Do not inspect an allowed role's effective tools or claim sandbox/capability enforcement.
- Do not change non-Plan behavior, omitted-allowlist compatibility, or `subagent_spawn` role policy.

## Risks

- `pi-subagents` may add or change actions independently. Unknown actions must remain fail-closed, and
  the README must state the exact read-only actions currently recognized rather than promising every
  future management action.
- A broad `if (action) return undefined` shortcut would let launch-like or mutating operations bypass
  role policy. Negative tests must cover execution aliases, unknown actions, and representative
  mutating/control actions.
- `agent` is overloaded: it is a launch role for execution but an inspection target for `get` and
  `models`. Classification must happen before role extraction only for explicitly verified read-only
  actions.

## Rollback / Recovery

This change has no data migration or persisted-state rewrite. If the action classification causes a
compatibility regression, revert the local classifier, documentation, and regression tests together;
existing settings files remain valid and untouched.

## Plan

- [x] Added focused failing cases to
  `extensions/pi-plan-mode/test/subagent-policy.test.ts` for every verified read-only action,
  including `get`/`models` targets absent from the role allowlist, plus negative execution-alias,
  malformed/unknown-action, and mutating/control cases. Red evidence: `npm test` failed the new
  read-only-action and non-read-only-action tests for the intended pre-fix behavior.
- [x] Added an active-Plan integration regression to
  `extensions/pi-plan-mode/test/subagent-allowlist.test.ts` proving `{ action: "list" }` and a
  read-only `agent` target reach the covered tool while a disallowed launch remains blocked. Red
  evidence: `npm test` failed the new hook assertion because Plan mode returned the reported
  `could not verify subagent roles` block.
- [x] Updated `extensions/pi-plan-mode/src/subagent-policy.ts` with an explicit read-only action
  classifier that bypasses role extraction only for verified inspection actions, preserves launch
  parsing for absent/execution actions and `subagent_spawn`, and fail-closes malformed, unknown, and
  non-read-only actions. Green evidence: the 15 focused policy/lifecycle tests pass; the full
  `npm test` run passed all changed tests and exposed one unrelated linked-worktree Git-runner test
  failure to resolve at the repository-gate step.
- [x] Updated the `Allowed Plan subagents` section of `extensions/pi-plan-mode/README.md` to
  distinguish launches from the 10 exact supported read-only management actions, document
  fail-closed malformed/unknown/non-read-only actions, and retain the independent-install and
  name-only safety limits. A scripted source/test/README comparison confirmed all 10 actions match,
  and a source/manifest search confirmed there is no `pi-subagents` import or dependency.
- [x] Ran `npm run check` against the exact working diff in a temporary normal clone (the active
  linked worktree makes an unrelated Git-alias environment test observe Git's injected `GIT_DIR`).
  Biome, boundary checks, all workspace typechecks, and all 1,941 tests passed; the temporary clone
  was removed afterward.
- [x] Ran `just pack-plan-mode` successfully and inspected the 19-file dry-run tarball: it contains
  the updated README and `src/subagent-policy.ts`, retains the 42-byte thin `src/index.ts`, and the
  manifest/source audit confirms no `pi-subagents` dependency or import was added.
- [x] Repeated the isolated live smoke with Pi `0.83.0`, local `pi-plan-mode` `0.42.0`, and npm-latest
  `pi-subagents` `0.38.0`. JSON events showed `{ "action": "list" }` ending with `isError: false`
  and `Executable agents:`, while a `worker` launch ended with `isError: true` and the exact Plan-mode
  role block. The temporary agent directory, credential copy, and evidence files were removed.
- [x] Audited the final diff against `docs/extension-conventions.md` and
  `docs/extension-settings.md`: the changed `tool_call` policy has deterministic unit and active-Plan
  coverage; omitted/empty/reload setting behavior remains covered; source/package independence,
  documentation, full checks, package preview, and runtime smoke are verified. Cancellation,
  disposal, session replacement, shutdown, persistence, migration, and UI are not touched; there are
  no accepted deviations.

## Completion Checklist

- [x] Configured active Plan mode permits every explicitly documented read-only `subagent`
  management action without treating inspection targets as launched roles, proven by unit,
  hook-level, and live-package evidence.
- [x] Single, parallel, chain, fan-in, aliased, and detached launches still reject every disallowed
  role before execution, and malformed or unknown action shapes remain fail-closed, proven by the 15
  focused tests and the live disallowed-role smoke.
- [x] Omitted allowlists, inactive Plan mode, absent `pi-subagents`, settings reload, and independent
  installation behavior remain unchanged, proven by the passing existing lifecycle tests, boundary
  gate, and package audit.
- [x] Source, tests, and README agree on the exact 10-action classification and safety boundary,
  proven by the scripted comparison and final diff audit.
- [x] `npm run check`, `just pack-plan-mode`, and the latest-package live smoke pass with recorded
  evidence and no unrelated repository changes.
