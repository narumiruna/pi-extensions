# Pi Langfuse Blocked Tool Input Plan

## Goal

Keep a blocked or otherwise non-executed tool observation on its raw model arguments while preserving final extension-mutated arguments for tools that actually execute.

## Context

PR #332 review `pullrequestreview-4758241509` identifies that pi-langfuse records `tool_call` input before later policy handlers can block execution. Pi emits `tool_result` only for executed calls, so that event is the reliable boundary for replacing the raw fallback with the executed input.

## Architecture

- Start each tool observation from `tool_execution_start` raw arguments.
- Update its input only from `tool_result`, which carries the arguments used by an executed tool after all `tool_call` mutations.
- Preserve existing output, error, progress, duplicate-ID, bounded-capture, and metadata-only behavior.

## Plan

- [x] Add a regression test for a prepared tool call that is later blocked and prove the current trace incorrectly replaces its raw input; the focused test failed with `prepared-but-blocked.ts` recorded instead of no input update.
- [x] Defer tool-input replacement until `tool_result`; all 46 pi-langfuse tests pass, including blocked raw input and final executed input assertions.
- [x] Update `extensions/pi-langfuse/README.md` to describe the corrected lifecycle semantics; the text now distinguishes blocked raw fallbacks from executed final input.
- [x] Run focused pi-langfuse tests, `npm run check`, `npm run pack:langfuse`, and `git diff --check`; all 46 focused tests and all 1,054 repository tests pass, and the dry-run package contains the documented five source modules.
- [ ] Commit and push the focused branch, then prepare the exact pull-request title and body for approval before creating the PR.

## Completion Checklist

- [x] Blocked and otherwise non-executed calls retain raw model arguments.
- [x] Successful and failed executed tools report the exact arguments they ran.
- [x] Existing trace output, timing, errors, duplicate handling, and privacy behavior remain unchanged.
- [ ] The branch is verified, pushed, and represented by a pull request to `main`.
