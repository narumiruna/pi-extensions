# Pi Langfuse Final Tool Input Plan

## Goal

Ensure each completed `pi.tool.*` observation reports the prepared and extension-mutated arguments that Pi actually executed, instead of leaving the raw model arguments from `tool_execution_start` as its final input.

## Context

PR #330 review `pullrequestreview-4757940837` correctly notes that Pi emits `tool_execution_start` before `prepareArguments` and `tool_call` handlers. Pi exposes prepared input through `tool_call` and the final executed input through `tool_result`; `tool_result` runs before `tool_execution_end`, so the recorder can update the active observation before closing it.

## Architecture

- Keep the raw start input as a fallback for missing, invalid, truncated, or blocked calls that never execute.
- Update the active tool observation from `tool_call` after argument preparation.
- Update it again from `tool_result` after all `tool_call` mutations, making that value authoritative for executed tools.
- Preserve duplicate-ID quarantine, bounded content capture, metadata-only mode, progress timing, and finalized output handling.

## Plan

- [x] Add an extension regression test that sends distinct raw, prepared, and final executed inputs and requires the trace to end with the executed input; verified it failed because no post-preparation input updates were recorded.
- [x] Add a bounded `TraceRecorder` tool-input update path and connect `tool_call` plus `tool_result` lifecycle events; verified all 46 pi-langfuse tests, including content-disabled, duplicate/unknown-ID, failed-tool, and native OTEL export assertions.
- [x] Update `extensions/pi-langfuse/README.md` to describe raw fallback and authoritative executed input semantics; verified the text matches Pi's documented and installed event ordering.
- [x] Run `npm run check`, `npm run pack:langfuse`, and `git diff --check`; verified 1,052 tests pass, the dry-run tarball contains all five source modules plus package documentation/metadata, and the final diff is limited to pi-langfuse plus this plan.

## Completion Checklist

- [x] Successful and failed executed tools end with their prepared, fully mutated execution input.
- [x] Calls that never reach execution retain a bounded raw-input fallback without creating orphan observations.
- [x] Tool outputs, progress metadata, failure severity, duplicate handling, and privacy behavior remain unchanged.
- [x] Tests, README, package contents, and repository checks pass.
