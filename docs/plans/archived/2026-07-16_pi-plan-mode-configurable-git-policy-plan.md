## Goal

Add a global, additive `safeSubcommands` setting to `pi-plan-mode.json`. Support vetted `git` and `gh` command paths while ensuring configuration only selects code-owned validators and never acts as a raw shell allowlist.

## Context

Plan mode currently permits eight built-in Git inspection subcommands and blocks `gh` as unknown. Issue #212 requests more read-only Git inspection commands. The owner chose a command-keyed settings shape that can support additional reviewed CLIs later without adding one top-level property per command.

## Architecture

```json
{
  "thinkingLevel": "inherit",
  "defaultPlanTools": ["read", "bash", "grep", "find", "ls"],
  "safeSubcommands": {
    "git": ["status", "log", "rev-parse", "blame"],
    "gh": ["pr view", "pr list", "issue view", "issue list"]
  }
}
```

- Extend `PlanModeSettings` with optional `safeSubcommands.git` and `safeSubcommands.gh` arrays.
- Accept existing built-in Git names `status`, `log`, `diff`, `show`, `branch`, `remote`, `ls-files`, and `grep`; these validators remain active even when omitted from configuration.
- Add opt-in Git validators for `rev-parse`, `blame`, `describe`, `merge-base`, `ls-tree`, and `cat-file`.
- Add exact opt-in `gh` paths `pr view`, `pr list`, `issue view`, and `issue list`. Configuring one path must not enable a sibling such as `pr merge`.
- Omitted `safeSubcommands`, `{}`, and empty arrays preserve current behavior. Deduplicate entries in first-seen order.
- Reject the entire settings file through the existing warning/fallback path when a command key, value, array item, or path is unsupported or malformed.
- Refactor shell policy into command-owned validator registries. Configuration resolves names to these validators; it never directly grants permission.
- Keep shared rejection of redirects, substitutions, subshells, background jobs, output writes, external diff/textconv/filter execution, browser-opening flags, and malformed option/subcommand layouts.
- Preserve `isSafeCommand(command)` as the strict default, add an explicit optional policy argument, and pass the session-loaded policy from the active Plan-mode `tool_call` hook.

## Non-Goals

- Do not support `kubectl` in this change; the map shape leaves room for a later vetted validator.
- Do not accept arbitrary commands, aliases, regular expressions, shell snippets, or user-defined validators.
- Do not add mutating Git or GitHub CLI operations.
- Do not claim sandbox-level safety or hide repository history, tracked secrets, or remote GitHub data.

## Plan

- [x] Keep the merged test decomposition: policy coverage lives in `extensions/pi-plan-mode/test/tool-policy.test.ts`, question coverage lives in `question-tool.test.ts`, and `plan-mode.test.ts` remains below 1,000 lines.
- [x] Added policy tests for all six requested Git examples, default denial, exact opt-in, and all-segment pipeline/list composition; the configured-positive assertions fail before implementation.
- [x] Added `gh` tests for exact opt-in paths and sibling denial, including the four allowed paths plus mutating siblings, aliases, `--web`, redirects, malformed layouts, and unsafe chains; configured-positive assertions fail before implementation.
- [x] Added maximal-policy adversarial Git tests for unknown policy names, output flags, external diff/textconv/filter execution, malformed layouts, global helper/alias options, and existing mutating `branch`/`remote` forms.
- [x] Extended settings normalization with strict `safeSubcommands` validation, ordered deduplication, only the `git` and `gh` keys, empty-value behavior, and preservation of `thinkingLevel`, `defaultPlanTools`, canonical migration bytes, and invalid-file fallback.
- [x] Refactored `extensions/pi-plan-mode/src/tool-policy.ts` around command-owned validator registries, shared guards, and policy-aware validation of every shell segment while preserving the strict default.
- [x] Passed session-loaded policy from the active `tool_call` hook and added lifecycle tests for valid config, removal/reload fallback, invalid warnings, active enforcement, and unchanged inactive behavior.
- [x] Updated `extensions/pi-plan-mode/README.md` with the complete schema, exact values, additive semantics, accepted/rejected examples, exact `gh` paths, and data-visibility warnings.
- [x] Completed a focused bypass scan across aliases, global options, redirects, expansions/substitutions, pagers, browsers, filters, helpers, chained segments, and siblings; added regressions for environment, pathname, and brace expansion plus newline command separation; environment/glob expansion was hardened after the scan exposed option-injection risk.
- [x] Ran targeted Biome with `--vcs-use-ignore-file=false`, pi-plan-mode typecheck, `npm test` (521 passing), full `npm run check`, an isolated `pi -ne -e ./extensions/pi-plan-mode --help` load smoke, and `just pack-plan-mode`; the dry run contains the expected 11 files.
- [x] Committed focused changes as `b197ed4`, pushed the feature branch, opened PR #220 referencing issue #212, and verified both GitHub CI matrix jobs passed with no actionable review comments; archive this completed ledger with the final documentation commit.
- [x] A follow-up edge-case audit blocked implicit textconv/external-diff/signature/transport helpers, dangerous abbreviated Git options, and attached or abbreviated branch mutations; `npm run check` passes 522 tests, the extension load smoke passes, and the 11-file package dry run remains correct.

## Risks

- Read-looking flags can execute configured filters, textconv drivers, difftools, browsers, editors, or pagers. Reject uncertain execution paths rather than infer safety from the command name.
- A generic settings map can look like an arbitrary allowlist. Strict command keys, exact supported paths, and code-owned validators must remain the enforcement boundary.
- Refactoring Git handling can regress established `branch`, `remote`, output, and external-diff checks; preserve the default matrix and run it with empty and maximal opt-in policies.
- `cat-file` can expose deleted history or tracked secrets, and `gh` can expose remote repository data, even when neither mutates state. Document these capabilities plainly.

## Rollback / Recovery

Because the setting is additive and omitted by default, recovery is to ignore optional entries with a warning and retain built-in Git validators. Never remove or weaken the built-in Git policy if an optional validator proves unsafe.

## Completion Checklist

- [x] Default Git behavior remains equivalent when `safeSubcommands` is absent or empty.
- [x] The six issue #212 Git commands require and honor exact opt-ins.
- [x] The four initial `gh` paths require and honor exact path opt-ins without allowing mutating siblings.
- [x] Unknown settings, unsafe flags, helper execution paths, redirects, malformed layouts, and mixed safe/unsafe chains fail closed.
- [x] Session reload/removal resets optional policy without affecting inactive Plan mode.
- [x] README, tests, package contents, local verification, and PR #220 CI match the implemented contract.
