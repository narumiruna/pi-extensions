# Plan mode question display

## Goal

Replace the raw `plan_mode_question` arguments and JSON in the transcript with a compact, themed answer summary. Expansion shows the complete questions, answers, and notes without changing model-visible data.

## Scope and required rules

- Tool display: preserve tool names, descriptions, schemas, execution, and result payloads (`docs/extension-conventions.md`, prompt-cache stability MUST; Review and existing cache-contract tests).
- TUI rendering: fit all lines to the supplied width, sanitize untrusted display text, preserve multiline answer whitespace in expanded detail, and apply the callback theme after invalidation (TUI MUST; renderer Tests and Review).
- Interaction: use Pi's existing expansion action and injected keybinding hints; add no input handlers or asynchronous resources (Review and configured-keybinding Tests).
- Runtime: keep the Kit root import lazy, keep narrow public Kit imports external, and load the generated entry through Pi's Jiti loader (build-backed runtime MUST; builder Tests and headless Pi Smoke).
- Documentation and release: document the summary and expansion, add a package patch changeset, and run both repository gates (documentation and versioning MUST; Review, `npm run check`, and `npm test`).
- Settings, persistence, session state, and question-editor behavior are unchanged; `docs/extension-settings.md` adds no touched requirements.

## Plan

- [x] Inspect the current tool, authoritative Pi renderer composition, package conventions, and test/build entrypoints; install dependencies with `npm install`.
- [x] Add call and result renderers with compact summaries, expanded detail, and clear cancellation/error states; 96 focused tests pass, including registration and cache-contract tests.
- [x] Test partial arguments/results, narrow and zero widths, resize, theme invalidation, multiline text, terminal controls, notes, and configured expansion hints; all 27 renderer tests pass.
- [x] Review the updated package README, patch changeset, and final diff against the touched-area rules; the independent review found no actionable issues, and the fenced-code-aware heading audit passed for all 38 active package READMEs.
- [x] Apply formatting, pass `npm run check`, inspect the package tarball, and pass the non-interactive package-directory Pi load smoke.
- [ ] Pass the full `npm test` gate; blocked by four unrelated failures reproduced on unchanged HEAD in a separate temporary worktree.

## Completion Checklist

- [x] The normal transcript contains no raw argument or result JSON for valid question results; tested through Pi's `ToolExecutionComponent` with default, remapped, and unbound expansion keys.
- [x] Expanded output preserves the complete question, answer, and note text after display-only sanitization; multiline wrap and raw-payload equality tests pass.
- [x] Existing questionnaire, non-TUI, lifecycle, generated-runtime, and cache-contract tests pass; the full run passed all 516 Plan mode tests across 40 files.
- [ ] Both repository gates and the package-directory load smoke pass; `npm run check` and the smoke pass, but the complete test gate remains blocked.

## Non-Goals

Do not change the questionnaire screen, commands, tool policy, completion tool, settings, session lifecycle, or model instructions. Do not publish or install the changed package into the user's Pi configuration.

## Verification evidence

The final semantic audit followed `docs/extension-conventions.md`, `docs/extension-settings.md`, and `docs/readme-conventions.md`. The change adds synchronous transcript rendering only. It changes no tool schemas, execution paths, model payloads, settings reads or writes, lifecycle ownership, cancellation handlers, or editors. Pi continues to own tool framing and expansion; narrow Kit rendering imports remain external, and interactive Kit imports remain lazy.

- `npm run format`: passed.
- `npm run check`: passed builds, Biome, boundaries, and workspace typechecks. Existing Biome schema and unrelated lint informational notices remain unchanged.
- Focused renderer, question-tool, registration, builder, and cache-contract tests: 96 passed, including 27 new renderer tests.
- `npm test`: 19,272 passed, 34 skipped, 4 failed across 901 files. All 516 Plan mode tests passed.
- Unchanged HEAD `24a07ad5` in a temporary external worktree reproduced the same four failures: one Fleet Unix socket path-length error, two Edit Scope assertions affected by wrapped long temporary paths, and one Edit Scope Unicode-filename assumption that does not hold on this macOS filesystem. The worktree was removed after verification.
- A targeted rerun with `TMPDIR=/tmp` fixed the three path-length failures; the Unicode-filename test still failed. No unrelated source or test files were changed.
- `npm run package:pack -- plan-mode`: passed. A real temporary npm tarball also contained the expected manifest, README, changelog, license, generated entry, source entry, and renderer among its 46 files; the tarball was removed after inspection.
- Package-directory Pi RPC smoke: passed `/plan` registration, `get_state`, and clean shutdown using an isolated agent directory and explicit package loading. No provider request was made.
- Generated-runtime tests passed through Pi's Jiti loader, including a representative lazy settings boundary.
- Independent read-only review: no actionable findings.

Logs are under `/tmp/pi-plan-mode-question-display-{check,test,pack,baseline-tests,environment-tests}.log`. This plan stays open because the required full test gate is not green; no exception has been granted.

## External Handoff

The repository maintainer must authorize a separate correction for the existing platform-dependent tests or provide a compatible test environment before the full test gate can pass. Do not treat this change as fully gate-verified or ready for release until that gate passes.

The user can review the appearance in their terminal after loading the changed package. Deterministic rendered previews and a headless load smoke passed, but the actual terminal and theme appearance remain unverified because this environment does not permit opening an interactive TUI. The changed package was not installed into the user's Pi configuration or published.
