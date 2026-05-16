## Goal

Build a publish-ready `@narumitw/pi-auto-thinking` extension that automatically selects Pi's thinking level for each user task based on the active model's reasoning capability and a deterministic task-difficulty heuristic. Success means the extension is packaged consistently with the monorepo, exposes understandable controls, avoids noisy UI behavior, and passes repository checks plus a package dry run.

## Context

- This repository is a Node/TypeScript monorepo for Pi extensions under `extensions/pi-*`.
- Existing extension packages import Pi APIs from `@mariozechner/pi-coding-agent` and expose source files through each package's `pi.extensions` field.
- Pi supports `before_agent_start`, `model_select`, and `thinking_level_select` extension events, and exposes `pi.getThinkingLevel()` / `pi.setThinkingLevel(level)`.
- `ctx.model` exposes model metadata including `provider`, `id`, `reasoning`, and `thinkingLevelMap`.
- Pi clamps `setThinkingLevel()` to model capabilities, but the extension should still compute and explain its intended decision.

## Architecture

- Add a new single-purpose package at `extensions/pi-auto-thinking`.
- Implement the extension in `src/auto-thinking.ts` with these internal modules/functions kept in the same file unless the file becomes hard to navigate:
  - config loading and validation
  - prompt scoring
  - model-aware level selection and clamping
  - runtime state and command handlers
- Keep runtime state in memory:
  - `enabled`
  - `lastDecision`
  - `manualSuppressionTurnsRemaining`
  - an `internalThinkingChange` guard to distinguish extension-triggered thinking changes from likely user changes
- Use `ctx.ui.setStatus("auto-thinking", ...)` for passive status and reserve `ctx.ui.notify()` for explicit commands or warnings.

## Tech Stack

- TypeScript, NodeNext, no new runtime dependencies by default.
- Use Node built-ins (`node:fs`, `node:path`, `node:process`) for optional JSON config loading.
- Use existing repository gates: Biome, TypeScript, `npm run check`, and npm pack dry run.

## Non-Goals

- Do not call an LLM to classify task difficulty in the MVP.
- Do not rewrite provider payloads or system prompts.
- Do not maintain a large hard-coded model profile database.
- Do not publish to npm as part of implementation unless explicitly requested.

## Assumptions

- The extension should default to enabled with conservative caps: `minLevel: "minimal"`, `maxLevel: "high"`.
- `xhigh` should only be selected when config or model override permits `maxLevel: "xhigh"`.
- The default config path should be `PI_CODING_AGENT_DIR/pi-auto-thinking.json`, falling back to `~/.pi/agent/pi-auto-thinking.json`.

## Plan

- [x] Confirm current package conventions and Pi API surface before editing; verified with `extensions/pi-statusline/package.json`, `extensions/pi-statusline/src/statusline.ts`, `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`, and `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`.
- [x] Create `extensions/pi-auto-thinking` package skeleton (`package.json`, `README.md`, `LICENSE`, `tsconfig.json`, `src/auto-thinking.ts`) following existing package naming and `pi.extensions` conventions; verified with `npm --workspace @narumitw/pi-auto-thinking run typecheck`.
- [x] Implement typed thinking-level utilities in `src/auto-thinking.ts` (`LEVELS`, level comparison, min/max clamp, supported-level filtering from `model.reasoning` and `model.thinkingLevelMap`) to produce deterministic candidate levels; verified with `npm --workspace @narumitw/pi-auto-thinking run typecheck`.
- [x] Implement JSON config loading with safe defaults for `enabled`, `minLevel`, `maxLevel`, `respectManualTurns`, and `modelOverrides`; verified with validation-branch code review and `npm run check`.
- [x] Implement prompt scoring as a pure deterministic heuristic with explicit keyword/structure weights for quick requests, simple Q&A, code paths, code blocks, debugging, tests, design, architecture, migration, refactor, security, and explicit “think hard” intent; verified by the score table in `extensions/pi-auto-thinking/README.md` and `npm run check`.
- [x] Implement `before_agent_start` behavior to skip when disabled or manually suppressed, compute a decision from prompt/images/model/config, compare against `pi.getThinkingLevel()`, call `pi.setThinkingLevel()` only when needed, then record `lastDecision`; verified with `npm --workspace @narumitw/pi-auto-thinking run typecheck` and the non-interactive Node extension event smoke test.
- [x] Implement `thinking_level_select` handling with an internal-change guard so extension-triggered changes do not count as manual overrides, while likely user changes suppress automation for `respectManualTurns`; verified by code review, `npm run check`, and the smoke test's extension-triggered level changes.
- [x] Implement `model_select` handling to refresh the passive status and let the next prompt recompute based on the new model; verified by code review and `npm run check`.
- [x] Register `/auto-thinking` command with `on`, `off`, `status`, and `explain` subcommands; verified by `pi -e ./extensions/pi-auto-thinking --no-session --no-context-files --no-skills -p "/auto-thinking status"` and README command documentation.
- [x] Update root integration points for consistency: root `package.json` pack script and `justfile` recipes for `pack-auto-thinking`, `try-auto-thinking`, `install-auto-thinking`, and `publish-auto-thinking`; verified with `just --list | grep auto-thinking`.
- [x] Write `extensions/pi-auto-thinking/README.md` with install/try instructions, config example, heuristic explanation, command reference, model capability behavior, and cost/latency caveats; verified package dry-run includes `README.md`, `LICENSE`, and `src/auto-thinking.ts`.
- [x] Run repository verification after implementation; verified with `npm run check`, `npm --workspace @narumitw/pi-auto-thinking pack --dry-run`, and `just pack-auto-thinking`.
- [x] Perform one bounded runtime smoke test with the local extension using one simple prompt, one design/debug prompt, a non-reasoning model case, and `/auto-thinking explain`; verified with the non-interactive Node extension event harness output `auto-thinking smoke test passed`.

## Risks

- Heuristic misclassification could increase cost or latency; mitigate with conservative defaults, `maxLevel: "high"`, `/auto-thinking off`, and clear `/auto-thinking explain` output.
- Manual override detection is approximate because `thinking_level_select` does not expose a source; mitigate with an internal-change guard and conservative suppression semantics.
- Model-specific thinking support can vary; mitigate by respecting `model.reasoning`, `thinkingLevelMap`, and Pi's built-in clamping.
- UI noise could annoy users; mitigate by using status text by default and notifications only for explicit commands or config warnings.

## Rollback / Recovery

- Users can disable behavior at runtime with `/auto-thinking off`.
- Users can remove the package from Pi configuration or uninstall the package if the extension causes bad defaults.
- If a release is published with bad behavior, ship a patch release that defaults `enabled` to `false` or tightens `maxLevel`, and document the config workaround in the README.

## Completion Checklist

- [x] The new extension package exists under `extensions/pi-auto-thinking` with package metadata, source, README, license, and tsconfig verified by file paths in the repository.
- [x] Automatic thinking selection is implemented through `before_agent_start` and model-aware clamping verified by code review and `npm run check`.
- [x] Runtime controls `/auto-thinking on|off|status|explain` are documented and verified by README review plus `pi -e ./extensions/pi-auto-thinking --no-session --no-context-files --no-skills -p "/auto-thinking status"`.
- [x] Root scripts/recipes include auto-thinking pack/try/install/publish entries verified by `just --list | grep auto-thinking`.
- [x] Repository quality gates pass, verified by `npm run check`.
- [x] Package contents are publish-ready, verified by `npm --workspace @narumitw/pi-auto-thinking pack --dry-run` and `just pack-auto-thinking`.
