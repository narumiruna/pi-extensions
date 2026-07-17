## Goal

Ensure Plan mode blocks multiline heredoc file writes through every effective tool named `bash`, including built-in-compatible overrides whose provenance is not `builtin`.

## Context

Issue #231 reports that a Python heredoc wrote a file while Plan mode remained active. The command parser already rejects newlines; the tool hook can bypass that parser when Pi reports the effective `bash` tool as non-built-in.

## Plan

- [x] Trace issue #231 through the Plan-mode `tool_call` hook and Pi tool provenance; verified that `isSafeCommand()` rejects heredocs but the hook skips non-built-in effective `bash` tools.
- [x] Add a hook-level regression that reproduces the bypass with an effective `bash` override and proves multiline commands are blocked while safe commands remain allowed; focused test failed before implementation because the hook returned `undefined` for the heredoc.
- [x] Apply limited-bash policy by tool name at the shared tool-call boundary and align documentation; focused Plan-mode policy suites pass (11/11).
- [x] Run the repository CI-equivalent gate and Plan-mode package dry run; `npm run check` passed (596 passed, 1 compatibility skip) and `just pack-plan-mode` listed the 12 intended package files with no artifact created.

## Risks

- A custom tool intentionally named `bash` will now receive the same read-only command policy as the built-in-compatible tool it overrides. This narrows the prior generic user-risk opt-in contract but closes a fail-open mutation path for the canonical shell tool name.

## Completion Checklist

- [x] Issue #231's exact Python heredoc is rejected by the `safe-subcommands.test.ts` hook-level regression.
- [x] Safe `git rev-parse --show-toplevel` still passes the same effective-override hook regression.
- [x] README safety and override behavior match runtime enforcement.
- [x] Full checks and package dry run pass; `npm run check` passed (596 passed, 1 skipped), `just pack-plan-mode` passed, and this completed plan is ready to archive.
