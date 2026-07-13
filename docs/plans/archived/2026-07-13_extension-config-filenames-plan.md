## Goal

Unify active extension config filenames as `<unscoped-package-name>.json` while safely preserving phase-1 compatibility for existing users.

## Non-Goals

- Do not rename `pi-sync.local.json`, state/lock/snapshot files, Pi core config files, or deprecated-extension config files.
- Do not change JSON schemas, environment variables, commands, or tools.

## Plan

- [x] Add isolated migration tests for `pi-lsp`, `pi-plan-mode`, `pi-google-genai`, `pi-statusline`, `pi-subagents`, and `pi-codex-accounts`, and confirm they fail against the old filenames. Evidence: red test runs failed on the old paths, missing migration behavior, and missing notice fields.
- [x] Implement package-local safe migration and canonical read/write paths for six extensions, including `pi-codex-accounts`, with new-file precedence, invalid-file behavior, migration fallback, and once-per-session notices where context is available. Evidence: migration, invalid-file, precedence, dangling-symlink fallback, credential permission, and legacy-lock tests pass in `npm test`.
- [x] Preserve Google GenAI `0600` permissions and make project-scoped legacy LSP config fallback-only rather than mutating the working tree. Evidence: Google mode assertions and LSP project-path existence assertions pass.
- [x] Update package/root documentation and repository guidance with the canonical naming rule, compatibility notes, and explicit exceptions. Evidence: package READMEs, root `README.md`, and `AGENTS.md` updated.
- [x] Run formatting, targeted tests, `npm run check`, legacy-name searches, and relevant package dry runs. Evidence: `npm run check` passed 367 tests; all six `just pack-*` dry runs passed; legacy search returned only compatibility code/tests/docs.

## Risks

- Migration races or I/O errors could lose the only valid config; install the canonical file exclusively and remove legacy only after success.
- Google GenAI and Codex Accounts files contain credentials; preserve private permissions and never include config values in warnings.
- Project LSP config may be tracked by Git; never auto-rename `.pi/lsp.json`.

## Completion Checklist

- [x] All six canonical paths and compatibility behaviors are verified by source, docs, and 367 passing tests.
- [x] LSP project config remains unmodified and Google GenAI/Codex Accounts permissions remain `0600`, verified by migration tests.
- [x] Naming guidance and exceptions are documented; `git diff --name-only` shows no pi-sync, state, or deprecated-extension changes.
- [x] `npm run check`, legacy-name audit, and all six package dry runs pass.
