## Goal

Make all Telegraph tools opt-in while adding a tool-independent `/telegraph create <markdown-file>` flow that safely derives a title and publishes only after interactive confirmation.

## Architecture

- Keep all three tools registered, but apply a persisted `tools` subset to Pi's active-tool list while preserving unrelated tools.
- Extend the existing private `pi-telegraph.json` schema with `tools` and `allowFilesOutsideWorkspace`; all credential-preserving writes remain atomic and locked.
- Extract create-page publication into command/tool-neutral logic so tool calls and file commands share validation, confirmation, account creation, API handling, status ownership, and result formatting.
- Parse YAML frontmatter with Pi's public `parseFrontmatter` API; title precedence is frontmatter `title`, first H1 plain text, then filename basename. Frontmatter is removed and H1 content is preserved.

## Non-Goals

- No slash-command get/edit replacements.
- No metadata-driven author overrides.
- No new frontmatter dependency.
- No live Telegraph or npm publication during verification.

## Assumptions

- Missing `tools` intentionally defaults to an empty selection.
- `allowFilesOutsideWorkspace` defaults to `false` and remains manually configurable.
- Filename fallback preserves basename text without title-casing.
- Repository release automation owns package versions.

## Plan

- [x] Start from merged `main` on `feat/telegraph-file-publishing`; verified `main` fast-forwarded to merge commit `3051881` and the new branch is active.
- [x] Add failing config and runtime-selection tests for default-disabled tools, strict config normalization, settings preservation, fail-closed startup, unrelated-tool preservation, and `/telegraph tools|enable|disable` persistence; verified the initial compile failure and behavior regressions before implementation.
- [x] Implement canonical tool names, config persistence, startup activation, status reporting, and interactive selection; focused config/selection suite passes 26/26.
- [x] Add failing file-command tests for title precedence, H1 preservation, quoting, disabled-tool operation, cancellation, malformed/empty/oversized files, file type/extension checks, workspace confinement, symlink escapes, and configured outside access; verified four expected command regressions before implementation.
- [x] Extract shared create-page logic and implement the bounded workspace-aware Markdown loader and `/telegraph create <file>` command; all 40 focused Telegraph tests pass.
- [x] Update README and command help with default-disabled behavior, config fields, tool controls, file scope, frontmatter/title rules, confirmation, and examples; focused help/config/file tests match the documented behavior.
- [x] Run explicit Biome checks, `npm run check`, and `just pack-telegraph`; `npm run check` passed with 583 tests plus 1 compatibility skip, and the dry-run package contains the intended 10 files without external mutation.
- [x] Review the diff for token leakage, active-tool clobbering, path escapes, and duplicated publication logic; no unresolved findings remained, commit `61a40c8` was pushed, and PR #233 includes verification evidence.

## Risks

- Default-disabled tools are intentionally behavior-changing; documentation and startup tests must make this explicit.
- File publication can expose private content; realpath containment, explicit opt-in, regular-file checks, size bounds, and final confirmation mitigate accidental publication.
- Config writes contain credentials; every selector/setup/account path must preserve the token and private atomic-write behavior.

## Completion Checklist

- [x] Default-disabled/selectable tools pass focused tests and `npm run check` (583 passed, 1 compatibility skip).
- [x] File title precedence, containment/opt-in, confirmation, and no-request-on-cancel pass focused command regressions.
- [x] Existing create/get/edit lifecycle tests pass when tools are enabled.
- [x] README/help/config examples match implementation and identify the default change.
- [x] `just pack-telegraph` contains only the intended ten package files.
- [x] Verification performed no live Telegraph or npm publication.
- [x] Final implementation branch was clean after commit, and PR #233 records verification plus the live-API test gap.
