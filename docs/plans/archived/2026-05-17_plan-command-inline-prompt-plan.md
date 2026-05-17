## Goal

Allow `@narumitw/pi-plan-mode` to accept an inline prompt through `/plan <prompt>` while keeping bare `/plan` behavior unchanged. Success means `/plan` still enters or manages Plan mode, and `/plan build the feature` enters Plan mode and immediately submits `build the feature` as the user prompt in Plan mode.

## Context

Codex implements this behavior in `third_party/codex/codex-rs/tui/src/chatwidget/slash_dispatch.rs`:

- Bare `SlashCommand::Plan` calls `apply_plan_slash_command()` and only switches to Plan mode.
- `SlashCommand::Plan if !trimmed.is_empty()` first calls `apply_plan_slash_command()`, then submits the remaining text as a user message in Plan mode.
- `third_party/codex/codex-rs/tui/src/chatwidget/tests/plan_mode.rs` has `plan_slash_command_with_args_submits_prompt_in_plan_mode`, which verifies `/plan build the plan` submits `build the plan` and leaves the active collaboration mode as `ModeKind::Plan`.

Current `extensions/pi-plan-mode/src/plan-mode.ts` treats the full slash argument as a subcommand only. If Plan mode is disabled, non-empty text such as `/plan build the plan` only enters Plan mode and drops the text.

## Non-Goals

- Do not change proposed-plan detection, implementation prompting, or read-only tool blocking.
- Do not add new slash commands.
- Do not implement Codex's fresh-context implementation option in this slice.

## Plan

- [x] Update `extensions/pi-plan-mode/src/plan-mode.ts` `/plan` command parsing so reserved subcommands `exit` and `off` keep disabling Plan mode, while any other non-empty argument is treated as an inline planning prompt; verified by code review of the handler branches.
- [x] Add `enterPlanModeWithPrompt(prompt, ctx)` that calls `enterPlanMode(ctx)`, notifies Plan mode is enabled, and sends the trimmed prompt via `pi.sendUserMessage()` when idle or `{ deliverAs: "followUp" }` when busy; verified by code review: it calls `enterPlanMode(ctx)` before `pi.sendUserMessage()`.
- [x] Keep bare `/plan` behavior unchanged: when Plan mode is off it only enters Plan mode; when Plan mode is on it opens the Plan mode menu; verified by reviewing the handler branches.
- [x] Update `extensions/pi-plan-mode/README.md` with examples for `/plan` and `/plan <prompt>`, including that the inline text becomes the first Plan-mode prompt; verified by README review.
- [x] Run `npm --workspace @narumitw/pi-plan-mode run typecheck`, `npm run check`, and `just pack plan-mode`; verified all commands passed and the dry-run tarball contains LICENSE, README.md, package.json, and src/plan-mode.ts.

## Risks

- If inline text is sent before `enterPlanMode()` finishes updating active tools/state, the first prompt could run with full tools. Mitigate by entering Plan mode and persisting/updating tools before `sendUserMessage()`.
- Some users might expect `/plan status` to be a status subcommand. Current package does not document `status`; this plan treats unknown non-empty args as prompts, matching Codex.

## Completion Checklist

- [x] `/plan <prompt>` starts Plan mode and submits `<prompt>` as a Plan-mode user prompt, verified by implementation review and `npm --workspace @narumitw/pi-plan-mode run typecheck`.
- [x] Bare `/plan`, `/plan exit`, and `/plan off` behavior remains unchanged, verified by implementation review.
- [x] Documentation shows both bare and inline `/plan` usage, verified by `extensions/pi-plan-mode/README.md`.
- [x] Repository checks pass, verified by `npm --workspace @narumitw/pi-plan-mode run typecheck`, `npm run check`, and `just pack plan-mode`.
