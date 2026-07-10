## Goal

Add a user-level `pi-btw.json` setting that lets `/btw` either inherit Pi's current thinking level or request a fixed level for side-question model calls, without changing the main session's thinking level.

Success means users can place this file at `$PI_CODING_AGENT_DIR/pi-btw.json` (normally `~/.pi/agent/pi-btw.json`):

```json
{
  "thinkingLevel": "high"
}
```

A missing file, an empty object, or an omitted `thinkingLevel` must use the level returned by `pi.getThinkingLevel()` at `/btw` invocation time.

## Context

- Pi's public term is **thinking level**: core settings use `defaultThinkingLevel`, while extensions read the effective runtime value through `pi.getThinkingLevel()`.
- `pi-btw` currently calls the provider-level `complete()` API without a thinking option. It therefore does not explicitly inherit the current Pi level today. This change preserves the no-config UX while making inheritance real.
- The provider-neutral pi-ai option is named `reasoning`, so the extension should translate its user-facing `thinkingLevel` setting into that internal option through `completeSimple()`.
- For the repository's current Pi target, accepted levels are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. `max` is out of scope until the target Pi/pi-ai types support it consistently.

## Architecture

- Config path: `join(getAgentDir(), "pi-btw.json")`; this uses Pi's existing agent-directory resolution, including its existing `PI_CODING_AGENT_DIR` support, without adding any pi-btw environment variable.
- Config shape: `{ "thinkingLevel"?: BtwThinkingLevel }`; omission means inherit. No separate `"inherit"` sentinel is needed.
- If `pi-btw.json` does not exist, do not create it or warn; silently inherit the current Pi thinking level and leave the filesystem unchanged.
- Load the small config file on each valid `/btw` invocation so edits apply to the next question without `/reload`.
- Resolution precedence: valid config override → current `pi.getThinkingLevel()`.
- Convert effective `off` to an omitted `reasoning` option; pass all other effective levels as `reasoning` to `completeSimple()`, which owns provider-specific mapping and capability clamping.
- Invalid JSON or an invalid `thinkingLevel` should produce a warning and fall back to the current Pi level rather than blocking the side question.

## Non-Goals

- Do not add project-local `.pi/pi-btw.json` precedence in this version.
- Do not add `/btw` subcommands, command-line overrides, or a settings UI.
- Do not change the selected model or mutate the main session's thinking level.
- Do not auto-create or write `pi-btw.json`, and do not add environment variables, custom thinking-token budgets, or release/version changes.

## Assumptions

- `pi-btw.json` is a user-global extension config, consistent with the requested filename and other package configs under the Pi agent directory.
- Unknown JSON keys may be ignored for forward compatibility, but a present invalid `thinkingLevel` invalidates that override and triggers fallback.

## Plan

- [x] Added config-contract tests in `extensions/pi-btw/test/btw.test.ts`; the initial `npm test` failed on the new missing exports before implementation.
- [x] Replaced the compatibility loader with a `completeSimple` loader; preference, fallback, and missing-export behavior pass under `npm test`.
- [x] Added exported normalization, file-loading, and effective-level helpers using `getAgentDir()` and `pi-btw.json`; tests use isolated temporary paths.
- [x] Resolved the effective thinking level inside the validated `/btw` command path; tests prove factory/invalid command paths do not read the level and helper tests prove inheritance and override precedence.
- [x] Routed side questions through `completeSimple()` with provider-neutral reasoning options; captured-call tests cover every supported level, auth environment, headers, and `off` omission, while source inspection confirms no `pi.setThinkingLevel()` call.
- [x] Added warning-and-inherit behavior for malformed, wrong-type, unsupported, and unreadable settings; missing settings remain silent and uncreated in tests.
- [x] Documented the complete `pi-btw.json` contract in `extensions/pi-btw/README.md`.
- [x] Ran `npm run check` successfully and inspected `just pack-btw`; the dry run contains only `LICENSE`, `README.md`, `package.json`, and `src/btw.ts`. An interactive smoke test was not required because the provider call and command-independent config flow are covered without external credentials.

## Risks

- Inheriting a high current level can make quick side questions slower or more expensive than the provider default used by the current implementation; the fixed config, including `off` or `low`, is the escape hatch and must be documented.
- Calling raw `complete()` with a generic field would behave inconsistently across providers; using `completeSimple()` is required for provider-neutral translation.
- A configured level may exceed the selected model's capabilities; pi-ai should clamp it, and documentation must describe the value as a requested level rather than a guarantee.

## Completion Checklist

- [x] No config and `{}` both use the current runtime Pi thinking level, with a missing config left uncreated, verified by `missing pi-btw settings inherit silently without creating a file` and `pi-btw settings override the current runtime thinking level` tests.
- [x] Every documented fixed level overrides inheritance only for the side call, verified by captured `completeSimple()` options and the absence of `pi.setThinkingLevel()` in `extensions/pi-btw/src/btw.ts`.
- [x] `off` omits provider reasoning and invalid config warns then inherits, verified by `side-question completion maps thinking levels into provider-neutral options` and invalid-settings tests.
- [x] Config location and behavior are documented in `extensions/pi-btw/README.md`, with no new environment variable, verified against `BTW_SETTINGS_FILE`, `BTW_THINKING_LEVELS`, and accepted-value tests.
- [x] Repository verification passed with `npm run check`; package inspection passed with `just pack-btw` and four intended tarball files.
