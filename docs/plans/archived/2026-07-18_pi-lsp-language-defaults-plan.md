## Goal

Expand pi-lsp's no-config server catalog across common programming, scripting, markup, and infrastructure languages while preserving correct commands, file routing, language IDs, recursive-scan exclusions, and clear user documentation.

## Context

The reference catalog includes auto-downloaded servers, project-root-aware alternatives, and overlapping servers. pi-lsp starts only commands already available on `PATH` and does not yet select routes by project markers, so this change will add direct-command defaults for currently uncovered language families without adding overlapping JavaScript/Python alternatives that would make default routing ambiguous.

## Non-Goals

- Do not auto-download or install language servers at runtime.
- Do not add project-root marker detection or conditional server activation.
- Do not add servers that require dynamically generated launch paths or editor-specific extension assets.

## Assumptions

- Existing Biome, ty, Ruff, rust-analyzer, and gopls defaults remain compatible.
- A default server may be unavailable until the user installs its command or supplies the documented environment override.
- Server-specific generated directories should be skipped during recursive discovery but remain available when explicitly requested.

## Plan

- [x] Inventory direct-command server definitions, extensions, launch arguments, and language IDs from the local reference catalog; evidence is the server and language registries under `third_party/` reviewed against pi-lsp's `{ command, extensions, initialization }` model.
- [x] Add a failing executable specification in `extensions/pi-lsp/test/lsp.test.ts` for the expanded default catalog, representative language IDs, and server-specific recursive-scan exclusions; the focused compiled test failed on the missing `rubocop` default adapter.
- [x] Extend `extensions/pi-lsp/src/types.ts` and `extensions/pi-lsp/src/adapters.ts` with optional per-server skip directories, the curated direct-command defaults, and standard language IDs; the focused compiled pi-lsp suite passes (8/8).
- [x] Update `extensions/pi-lsp/README.md` and `README.md` with the expanded built-in language/server coverage, command requirements, configuration semantics, and scan-exclusion behavior; a bounded case-insensitive search confirms no reference-implementation attribution in either user-facing file or this plan.
- [x] Run `npm run check`, `npm run pack:lsp`, and `git diff --check`; checks pass (598 passed, 1 skipped), and the dry-run tarball contains the expected 12 files.

## Risks

- Incorrect startup arguments can make an installed server appear available but fail initialization; command arrays are covered by the catalog test, while version-specific external server interoperability remains an accepted dependency on user-installed binaries.
- Incorrect language IDs can degrade diagnostics silently; non-trivial extension mappings are covered by tests.
- Broad recursive scans can consume the file cap on generated trees; server-specific skip directories and explicit-path behavior are covered by tests.
- Overlapping defaults can make `lsp_fix` ambiguous or cause diagnostics to require multiple commands; the catalog intentionally avoids new alternatives for extensions already covered by an existing default.

## Completion Checklist

- [x] The expanded no-config catalog is verified by focused tests covering every new server's name, command, extensions, and representative language ID (8/8 focused tests pass).
- [x] Generated directories are excluded only from recursive discovery and explicit paths remain usable, verified by the default/common and custom skip-directory focused tests.
- [x] User-facing documentation describes the expanded defaults without reference-implementation attribution, verified by file inspection and a bounded case-insensitive text search.
- [x] Repository checks pass with `npm run check` (598 passed, 1 skipped).
- [x] Published package contents remain correct as verified by `npm run pack:lsp` (12 expected files).
