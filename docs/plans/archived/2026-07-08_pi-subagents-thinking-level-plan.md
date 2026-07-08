## Goal

Resolve [issue #147](https://github.com/narumiruna/pi-extensions/issues/147) by adding explicit thinking-level control to `@narumitw/pi-subagents` subprocess invocations.

Success means a caller can request Pi thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`) for single, parallel, chain, and aggregator subagents, and tests prove the chosen level is passed to the spawned `pi --thinking <level>` command without breaking existing model, tool, timeout, or project-agent behavior.

## Context

`extensions/pi-subagents/src/subagents.ts` currently starts workers as `pi --mode json -p --no-session`, optionally adding `--model`, `--tools`, `--no-tools`, and `--append-system-prompt`. Pi CLI supports `--thinking <level>` and `--model <pattern>:<thinking>`, but the extension has no first-class `thinkingLevel` parameter or agent default.

Existing agent definitions/config support `model`, `tools`, and `timeoutMs`; the `/subagents:config` UI only edits tools but intentionally preserves other config fields when saving.

## Architecture

Add a small, validated `ThinkingLevel` union inside `pi-subagents` and thread it through the same places that already carry timeout/model overrides:

- tool call params: top-level `thinkingLevel` plus per task/chain step/aggregator `thinkingLevel`;
- agent defaults: custom-agent frontmatter `thinkingLevel` and config-file override `agents.<name>.thinkingLevel`;
- subprocess launch: pass the resolved value as `--thinking <level>`.

Suggested precedence: local item `thinkingLevel` > top-level `thinkingLevel` > resolved agent default `thinkingLevel` > omit `--thinking` and preserve current Pi subprocess defaults/model-suffix behavior.

Keep `model: sonnet:high` working as it does today. If both `model` contains a thinking suffix and an explicit `thinkingLevel` is resolved, pass both `--model` and `--thinking`; Pi's CLI should treat `--thinking` as the explicit override.

## Non-Goals

- Do not make subagents implicitly inherit the parent session's current thinking level in this slice; omitted `thinkingLevel` should preserve existing subprocess defaults.
- Do not redesign `/subagents:config` into a full model/timeout/thinking editor; only preserve and normalize the new field like the existing non-UI `model` and `timeoutMs` settings.
- Do not add provider/model capability detection in the extension; Pi already clamps unsupported thinking levels at model resolution time.

## Plan

- [x] Add failing tests in `extensions/pi-subagents/test/subagents.test.ts` for accepted `thinkingLevel` values in the tool schema and config normalization; verify initial failures with `npm test` from the repository root.
- [x] Extract a small subprocess-argument helper from `runSingleAgent()` in `extensions/pi-subagents/src/subagents.ts` so tests can assert generated Pi args without spawning a subprocess; verify existing args for `--mode json -p --no-session`, `--model`, `--tools`, `--no-tools`, and `--append-system-prompt` remain unchanged with targeted tests.
- [x] Add `thinkingLevel` to `TaskItem`, `ChainItem`, `AggregatorItem`, and top-level `SubagentParams` using an enum schema for `off|minimal|low|medium|high|xhigh`; verify schema tests cover the field descriptions and invalid values are rejected by TypeScript/schema validation paths.
- [x] Extend `AgentConfig`, `SubagentAgentConfig`, `discoverAgents()`, `normalizeAgentSettings()`, and `hasAnyAgentOverride()` to support `thinkingLevel`; verify custom-agent frontmatter and config override tests cover valid values, invalid config rejection, null clearing, and preservation when `/subagents:config` saves tool defaults.
- [x] Resolve the final thinking level in each execution path (`single`, `parallel`, `chain`, `aggregator`) with precedence local item > top-level > agent default; verify argument-helper tests cover each mode and precedence branch.
- [x] Pass the resolved thinking level to `runSingleAgent()` and add `--thinking <level>` only when a value is resolved; verify tests assert no `--thinking` is emitted when omitted, preserving current behavior.
- [x] Include the requested `thinkingLevel` in `SingleResult` details and optionally render it beside model/usage so users can confirm what was requested; verify renderer or details tests cover at least the details field.
- [x] Update `extensions/pi-subagents/README.md` with tool examples, custom-agent frontmatter, runtime-limit/config notes if needed, and the exact supported levels; verify examples match the TypeScript schema by inspection.
- [x] Run `npm run check` from the repository root and fix formatting, type, or test failures.

## Risks

- Adding too many override locations can make precedence confusing; keep the documented order explicit and covered by tests.
- If Pi CLI behavior changes for `--model foo:high` plus `--thinking low`, this extension should still pass explicit arguments predictably and let Pi own model capability clamping.
- `/subagents:config` only edits tools, so users who want persistent thinking defaults must edit `pi-subagents-config.json` or agent frontmatter manually until a broader config UI exists.

## Completion Checklist

- [x] `subagent` accepts `thinkingLevel` at top level, per task, per chain step, and per aggregator, verified by schema/assertion tests in `extensions/pi-subagents/test/subagents.test.ts`.
- [x] Custom agents and config overrides can set or clear default `thinkingLevel`, verified by discovery/normalization tests.
- [x] Spawned Pi subprocess args include `--thinking <level>` for resolved values and omit it otherwise, verified by argument-helper tests.
- [x] Existing model/tool/timeout/project-agent behavior remains unchanged, verified by existing tests plus new regression assertions.
- [x] README documents the feature and supported levels, verified by review of `extensions/pi-subagents/README.md`.
- [x] Repository verification passes with `npm run check`.
