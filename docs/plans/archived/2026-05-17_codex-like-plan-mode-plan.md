## Goal

Implement a Codex-like Plan mode as a Pi extension package that lets users enter a read-only conversational planning mode, collaborate until a decision-complete implementation plan is produced, and then explicitly leave plan mode before code mutation happens.

## Context

Codex separates two concepts that should not be conflated:

- Plan mode is a collaboration mode: non-mutating exploration, user clarification, and a final `<proposed_plan>` block.
- `update_plan`-style TODO tracking is execution progress tracking and should not be used as the Plan mode UI itself.

Pi already has a sample `examples/extensions/plan-mode/` extension with useful primitives (`registerCommand`, `registerFlag`, `setActiveTools`, `tool_call` blocking, injected context, `setStatus`, `setWidget`, `appendEntry`). That sample is read-only and TODO-oriented, but the Codex-like target should emphasize conversational planning and explicit exit to execute.

## Architecture

Created a new workspace extension, `extensions/pi-plan-mode`, rather than mixing this into `pi-goal`:

- Command layer: one `/plan` top-level command toggles or manages Plan mode.
- Runtime state: per-session mode state persisted with `appendEntry` and restored on `session_start`.
- Safety layer: restrict active tools and block mutating bash/tool calls while Plan mode is active.
- Prompt layer: inject Codex-like Plan mode instructions before agent turns.
- Finalization layer: detect or guide `<proposed_plan>` output, then let the user explicitly leave Plan mode before implementation.

## Non-Goals

- Do not implement code changes while Plan mode is active.
- Do not build a separate `update_plan` TODO tool in v1.
- Do not make Plan mode depend on `pi-goal` goal-loop behavior.
- Do not replace Pi's normal planning guidance outside Plan mode.

## Assumptions

- V1 uses `/plan` as the only top-level command for this extension.
- A final plan is considered complete when the assistant emits a single `<proposed_plan>...</proposed_plan>` block.
- Read-only bash allowlisting starts from the Pi sample extension and can be tightened as issues are found.

## Unknowns

- [x] Whether Pi core exposes enough collaboration-mode metadata to make Plan mode visible outside extension status widgets; resolved by implementing extension status/widget UI because Pi core does not expose a native collaboration mode API.
- [x] Whether `ctx.ui.select()` is available in all target modes, including RPC; resolved by using `ctx.hasUI` guards and documenting Plan mode as an interactive extension workflow.

## Plan

- [x] Create `extensions/pi-plan-mode` with `package.json`, `tsconfig.json`, `README.md`, `LICENSE`, and `src/plan-mode.ts` following existing package structure; verified with `npm --workspace @narumitw/pi-plan-mode run typecheck`.
- [x] Add the package to root workspaces/scripts/just recipes only where this repository expects per-package support (`pack`, `try`, `install`, `publish`); verified with `just --list | rg "plan-mode"` and `npm run check`.
- [x] Implement persisted Plan mode state with fields for `enabled`, optional latest proposed plan text, and optional awaiting-user-action flag; verified by typecheck and code review of `STATE_ENTRY_TYPE` persistence/restore paths in `extensions/pi-plan-mode/src/plan-mode.ts`.
- [x] Register `/plan` and optional `--plan` flag so `/plan` enters Plan mode when off and shows a small action menu/status when on; verified by `pi -e ./extensions/pi-plan-mode --help` showing `--plan` and by typecheck.
- [x] Inject Codex-like Plan mode instructions in `before_agent_start`: three phases, explore first, ask only non-discoverable questions, no mutations, final `<proposed_plan>` block; verified by code review of `buildPlanModePrompt()`.
- [x] Restrict tools while Plan mode is active by calling `setActiveTools` with read/search/question tools and restoring the prior/full tool set when leaving Plan mode; verified by typecheck and code review of `activateReadOnlyTools()`/`restoreTools()`.
- [x] Add a `tool_call` guard for `bash` that blocks mutating commands using an allowlist/denylist derived from the sample extension; verified by code review of `MUTATING_BASH_PATTERNS`, `SAFE_BASH_PATTERNS`, and successful `npm run check`.
- [x] Detect `<proposed_plan>` in assistant output after `agent_end`, store the latest plan, display a concise status/widget, and prompt the user to stay in Plan mode, refine, or exit Plan mode; verified by code review of `PROPOSED_PLAN_PATTERN` and `showPlanReadyMenu()`.
- [x] Ensure execution is explicit: exiting Plan mode restores full tools but does not automatically run implementation unless the user sends a normal follow-up request; verified by code review of the `Implement this plan` branch, which exits Plan mode and notifies without sending an implementation turn.
- [x] Document Codex-like behavior, safety rules, slash command usage, examples, and known limitations in `extensions/pi-plan-mode/README.md`; verified with README review and `npm run check`.
- [x] Run repository verification with `npm run check`; for packaging changes, run `just pack plan-mode` and inspect the dry-run file list; verified by successful command outputs.

## Risks

- Tool restriction may be incomplete if Pi tools are added by other extensions after Plan mode activates; accepted for v1 and documented as a safety approximation.
- Bash filtering can block harmless commands or allow obscure mutations; mitigated with conservative defaults and clear block messages.
- Automatic `<proposed_plan>` detection may miss malformed plans; mitigated by keeping user-visible `/plan` status and allowing refinement rather than treating detection as authoritative.

## Completion Checklist

- [x] A new `@narumitw/pi-plan-mode` package exists and is included in workspace tooling, verified by `npm run check` and `just pack plan-mode` output.
- [x] Plan mode prevents repo-tracked mutations while active, verified by implemented edit/write blocking and bash allowlist/denylist guards in `extensions/pi-plan-mode/src/plan-mode.ts` plus successful typecheck.
- [x] Plan mode injects Codex-like conversational planning instructions and final `<proposed_plan>` requirements, verified by `buildPlanModePrompt()` in `extensions/pi-plan-mode/src/plan-mode.ts`.
- [x] Users can enter, inspect, refine, and explicitly exit Plan mode through `/plan`, verified by `/plan` command implementation, `--plan` help output from `pi -e ./extensions/pi-plan-mode --help`, and successful `npm run check`.
- [x] Documentation explains usage and safety boundaries, verified by `extensions/pi-plan-mode/README.md` review and `npm run check`.
