## Goal

Add Pi command-level argument autocomplete for `/pisync` first, then make the same small fix for other active extension commands where static subcommands or flags exist. Success means commands register `getArgumentCompletions`, suggestions use the `/goal` shape (`value`, command-token `label`, optional `description`), tests cover prefix behavior, and `npm run check` passes.

## Context

Pi already supports command argument completion through `registerCommand(..., { getArgumentCompletions(prefix) })`; no custom autocomplete provider is needed.

Current active command status:

- Done: `/goal`.
- Missing and useful: `/pisync`, `/codex-status`, `/plan`.
- Already present but worth auditing against `/goal` behavior: `/caffeinate`, `/firecrawl`, `/chrome-devtools`.
- Skip: `/btw` and `/wait-what` are free-form text; `/lsp` and `/subagents:config` have no useful static args.

## Non-Goals

- Do not autocomplete dynamic remote data such as R2 buckets, snapshot ids, sessions, model ids, files, or agents.
- Do not autocomplete free-form prompts, questions, or goal/objective text.
- Do not add a shared package/helper just for a few static arrays; each extension is independently published.

## Plan

- [x] Add `completeSyncArguments(argumentPrefix)` in `extensions/pi-sync/src/sync.ts` and wire it into `/pisync`; suggested subcommands (`help`, `init`, `config`, `status`, `diff`, `doctor`, `push`, `pull`, `sync`, `history`, `rollback`, `unlock`) and only useful accepted flags (`--yes`, `-y`, `--force`, `--stale`) for matching subcommands; verified with `extensions/pi-sync/test/sync.test.ts` and `npm run check`.
- [x] Cover `/pisync` completion edge cases in `extensions/pi-sync/test/sync.test.ts`: empty args, partial subcommand, command plus trailing space, flag prefix after `push`/`pull`/`sync`, `rollback <snapshot> --y`, `unlock --s`, and objective-like/unknown prefixes returning `null`; verified with `npm test` and `npm run check`.
- [x] Audit existing autocomplete helpers in `pi-caffeinate`, `pi-firecrawl`, and `pi-chrome-devtools`; preserved trailing spaces with `trimStart()` instead of `trim()` and moved descriptive text from `label` to `description`; verified with updated package tests and `npm run check`.
- [x] Add tiny static completions for `/codex-status` options (`--refresh`, `--no-statusline`, `--clear-statusline`, `--timeout`) in `extensions/pi-codex-usage/src/codex-usage.ts`; verified with completion tests and `npm run check`.
- [x] Add tiny static completions for `/plan` management tokens (`exit`, `off`, `tools`) while returning `null` after free-form prompt-like text; verified with plan-mode tests and `npm run check`.
- [x] Run `npm test` after the focused changes, then `npm run check` from the repository root; both passed.
- [x] Not applicable: skipped interactive Pi TUI smoke-test because `npm run check` verifies command registration and completion helpers non-interactively.

## Risks

- [x] Mitigated: `getArgumentCompletions` receives the full argument prefix, not just the current token; tests preserve trailing spaces.
- [x] Mitigated: over-completing free-form commands is worse than no completion; helpers return `null` once user text is likely not a command token.
- [x] Mitigated: `/pisync rollback` snapshot ids are dynamic; completion suggests only `--yes` flags around snapshot text, not fake ids.

## Completion Checklist

- [x] `/pisync` registers `getArgumentCompletions`, verified by `extensions/pi-sync/test/sync.test.ts`.
- [x] Static suggestions only include accepted commands/options, verified by unit tests against parser behavior.
- [x] Existing autocomplete commands are not noisier after completed commands, verified by updated tests where touched.
- [x] `/codex-status` and `/plan` are completed with tests, verified by `extensions/pi-codex-usage/test/codex-usage.test.ts` and `extensions/pi-plan-mode/test/plan-mode.test.ts`.
- [x] The full repository gate passes with `npm run check`.
