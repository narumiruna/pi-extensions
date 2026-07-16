## Goal

Add an opt-in, additive configuration for a small vetted set of read-only Git inspection subcommands so Plan mode can run the issue #212 examples without allowing arbitrary Git or weakening existing argument-level mutation and command-execution protections.

## Context

`isSafeCommand()` currently permits eight built-in Git subcommands and applies extra checks to risky `branch`, `remote`, diff/textconv, pager, and output forms. The policy is evaluated by `pi-plan-mode` before another permission extension can participate, so the opt-in must live in this extension.

This is the recommended second sequential change for issue #212, after `docs/plans/2026-07-16_pi-plan-mode-default-tools-plan.md`. If implemented independently, rebase its settings-schema and test-file changes before starting rather than duplicating them.

## Architecture

Extend the user-global settings file with an optional additive property:

```json
{
  "additionalSafeGitSubcommands": [
    "rev-parse",
    "blame",
    "describe",
    "merge-base",
    "ls-tree",
    "cat-file"
  ]
}
```

- The built-in Git policy remains active regardless of this setting; the property can add vetted policies but cannot replace or remove built-ins.
- Omitted or empty configuration preserves current behavior.
- Accepted values are a documented, versioned set of subcommands for which the extension implements argument validation. Unknown strings and malformed items invalidate the settings file through the existing warning/fallback path rather than becoming arbitrary allowlist entries.
- Refactor Git handling into a registry of named subcommand validators. Configuration activates validators; it never turns a string directly into permission.
- Shared Git guards continue rejecting output files, external diff/textconv execution, editor/pager execution paths, and unsupported shell syntax. Subcommand-specific guards must reject execution-capable forms such as `git cat-file --filters` and retain all existing mutating `branch`/`remote` rejections.
- `isSafeCommand()` receives the resolved opt-in policy explicitly, while its default call remains backward-compatible and strict. The active Plan-mode `tool_call` hook passes the session’s loaded policy.

## Non-Goals

- Do not allow user-defined arbitrary Git subcommands, shell fragments, regular expressions, or command templates.
- Do not make `bash` unrestricted or delegate blocked commands to a later permission extension.
- Do not claim that read-only Git access hides repository history, tracked secrets, hooks, filters, or project-defined behavior; this remains extension-level risk reduction, not a sandbox.
- Do not broaden unrelated shell commands or add write-capable Git operations such as checkout, switch, reset, clean, commit, tag mutation, config mutation, remote mutation, or branch mutation.

## Plan

- [x] Extracted the existing shell/tool-policy tests into `extensions/pi-plan-mode/test/tool-policy.test.ts` and question-tool tests into `extensions/pi-plan-mode/test/question-tool.test.ts` without changing behavior; `plan-mode.test.ts` is now 986 lines and `npm test` passes 515/515.
- [ ] Add failing policy tests showing all six requested examples are blocked by default, become allowed only when their named vetted policies are enabled, and remain composable only in pipelines/lists whose every segment is safe; verify the new assertions fail before implementation.
- [ ] Add adversarial failing tests for unknown configured names, `cat-file` filter/textconv execution, output-writing flags, malformed Git option/subcommand layouts, and existing mutating `branch`/`remote` forms under the broadest opt-in; verify each case fails for one clear policy reason before implementation.
- [ ] Extend `PlanModeSettings` normalization in `extensions/pi-plan-mode/src/settings.ts` with deduplicated, strictly validated `additionalSafeGitSubcommands`, preserving omitted/empty defaults, canonical migration behavior, and any previously implemented `defaultPlanTools` semantics; verify with settings tests and `npm run typecheck --workspace @narumitw/pi-plan-mode`.
- [ ] Refactor `extensions/pi-plan-mode/src/tool-policy.ts` to resolve Git subcommands through built-in and opt-in validator registries, centralize shared no-write/no-external-execution guards, and pass the optional policy through `isSafeCommand()`; make the smallest implementation that passes the positive and adversarial matrices without loosening defaults.
- [ ] Load and pass the resolved policy from `extensions/pi-plan-mode/src/plan-mode.ts` into the active Plan-mode `tool_call` gate, reset it on every `session_start`, and add lifecycle tests proving valid configuration applies, removed/invalid configuration falls back on the next session, and inactive Plan mode is unchanged.
- [ ] Update `extensions/pi-plan-mode/README.md` with the additive setting, exact supported values, enabled examples, rejected dangerous counterparts, and the limitation that repository contents/history remain readable; verify documentation against the executable matrix and inspect `just pack-plan-mode` output.
- [ ] Perform a focused sibling scan across every Git validator and shell-segment path for aliases, global options, redirects, substitutions, pagers, filters, external commands, and chained segments; fix only plausible bypasses demonstrated by regression tests, then run `npm run check`.

## Risks

- Git options that appear read-only can execute configured helpers, filters, textconv drivers, difftools, editors, or pagers. Validators must reject uncertain execution paths rather than infer safety from the subcommand name.
- A generic configurable string allowlist would convert future or aliased Git behavior into an accidental escape hatch; configuration must select code-owned validators only.
- Refactoring the current Git branch may regress its established `branch`, `remote`, output, and external-diff checks; preserve the old matrix and run it under both empty and maximal opt-in policies.
- `cat-file` can expose deleted history or tracked secrets even when it does not mutate the repository. Document this capability plainly.

## Rollback / Recovery

Because the setting is additive and omitted by default, recovery is to ignore the optional list with a warning and retain the built-in validator registry. Do not remove or weaken the built-in Git policy if an optional validator proves unsafe.

## Completion Checklist

- [ ] Default Plan-mode Git behavior remains equivalent at the policy boundary, verified by the pre-existing command matrix with no opt-in configuration.
- [ ] The six issue #212 inspection examples are accepted only when their vetted validators are configured, verified by positive and default-denial tests.
- [ ] Unknown names, malformed settings, mutating Git forms, output writes, filters/textconv, helper execution, and unsafe chained segments fail closed, verified by adversarial tests.
- [ ] Configuration is additive and resets on session reload/removal without affecting inactive Plan mode, verified by settings and lifecycle tests.
- [ ] README examples and warnings match the supported validator registry and security limitations, verified by source/test comparison and inspected `just pack-plan-mode` contents.
- [ ] Repository verification passes with `npm run check`, with no unresolved same-pattern bypass found in the final Git/shell policy scan.
