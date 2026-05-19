## Goal

Merge the pi-lsp tool-surface simplification and language/file-extension classification work into one implementation plan.

Change `@narumitw/pi-lsp` from seven backend-specific public tools to three language/file-extension routed action tools:

- `lsp_diagnostics`: runs diagnostics through routes selected from file extensions and optional language/checker hints.
- `lsp_format`: formats one file through the formatter route selected from its file extension.
- `lsp_fix`: applies source fixes/import organization through the fixer route selected from its file extension.

Success means the public API no longer requires users or the model to call backend-specific names, while current Biome, ty, and Ruff behavior remains available through explicit, documented routing rules.

## Context

Current public tools in `extensions/pi-lsp/src/pi-lsp.ts` are backend-specific:

- `biome_lsp_diagnostics`, `biome_lsp_format`, `biome_lsp_fix`
- `ty_lsp_diagnostics`
- `ruff_lsp_diagnostics`, `ruff_lsp_format`, `ruff_lsp_fix`

The existing internals already separate backend behavior from actions:

- `extensions/pi-lsp/src/adapters.ts`: Biome, ty, and Ruff adapter definitions, including supported-file predicates.
- `extensions/pi-lsp/src/runner.ts`: action-oriented `runDiagnostics`, `runFormat`, and `runFix`.
- `extensions/pi-lsp/src/pi-lsp.ts`: current public tool definitions and registration.

`third_party/opencode` provides the routing model to borrow, not the full architecture:

- `third_party/opencode/packages/opencode/src/lsp/server.ts`: LSP servers declare IDs, extensions, root detection, and spawn behavior.
- `third_party/opencode/packages/opencode/src/lsp/lsp.ts`: files are matched to applicable servers by extension and root.
- `third_party/opencode/packages/opencode/src/lsp/language.ts`: file extensions map to LSP language IDs.

For this repository, keep pi-lsp small: do not copy opencode's long-lived LSP manager, auto-install behavior, or custom server registry in this change.

## Architecture

Add a narrow routing layer above the existing adapters and runner:

```txt
Pi tool params
  -> language/file-extension route selection
  -> existing adapter(s)
  -> existing runDiagnostics/runFormat/runFix
```

Public routing rules:

- Biome-supported extensions route to Biome for diagnostics, format, and fix.
- Python `.py`/`.pyi` diagnostics can route to:
  - ty for type diagnostics
  - Ruff for lint diagnostics
  - both when requested
- Python `.py`/`.pyi` format/fix routes only to Ruff.
- Unsupported extensions fail with a clear message naming supported language/file-extension classes.

Suggested internal module:

- Add `extensions/pi-lsp/src/routes.ts` or equivalent.
- Keep route selection centralized and typed.
- Reuse `biomeAdapter.isSupportedFile`, `tyAdapter.isSupportedFile`, and `ruffAdapter.isSupportedFile` instead of copying extension lists.
- Return route metadata such as `{ adapter, action, language, reason }` when useful for readable errors and multi-route summaries.

## Non-Goals

- Do not rewrite the JSON-RPC LSP client or runner.
- Do not add persistent LSP clients, client reuse, or opencode-style session state.
- Do not add new backends such as ESLint, tsserver, pyright, basedpyright, or gopls.
- Do not add custom LSP server configuration.
- Do not split formatting into a separate formatter extension in this phase.
- Do not change deprecated LSP packages except for intentional migration documentation.

## Assumptions

- This is a breaking public tool-name change unless deprecated aliases are deliberately kept.
- The preferred public surface is three tools, not one catch-all `lsp` tool.
- Python format/fix is a Ruff concern; ty is diagnostics-only.
- Directory diagnostics may include mixed language/file-extension routes.

## Unknowns

- Whether `language` should be required or inferred from `path`/`paths`. Recommended: infer from path when possible; allow optional `language` only as a disambiguating override.
- Whether Python diagnostics should default to `checker: "all"`, `"type"`, or `"lint"`. Recommended: default to `"all"` for completeness, but document the latency tradeoff.
- Whether old backend-specific tool names should be removed immediately or kept as aliases. Recommended: remove them from the public tool list and provide a README migration table; add aliases later only if compatibility becomes necessary.

## Plan

- [ ] Decide and document the final public schema in `extensions/pi-lsp/README.md` before implementation; verify the schema covers diagnostics, format, and fix without requiring backend-specific tool names.
- [ ] Use this initial schema unless implementation discovers a blocker:
  - `lsp_diagnostics({ paths?, root?, limit?, language?, checker? })`, where `language` is optional and `checker` is meaningful for Python as `"type" | "lint" | "all"`.
  - `lsp_format({ path, root?, write?, language? })`.
  - `lsp_fix({ path, root?, kind?, write?, language? })`.
- [ ] Decide old-name compatibility policy; recommended outcome is no deprecated aliases in the first implementation, with a README migration table from the seven old tools to the three new calls.
- [ ] Add a route-selection helper under `extensions/pi-lsp/src/`; verify by code review that route selection is centralized and ty cannot be selected for format/fix.
- [ ] Reuse existing adapter predicates for file support; verify route decisions against `extensions/pi-lsp/src/adapters.ts` rather than duplicated extension constants.
- [ ] Replace backend-specific tool definitions in `extensions/pi-lsp/src/pi-lsp.ts` with `lsp_diagnostics`, `lsp_format`, and `lsp_fix`; verify registration names by code review and non-interactive extension inspection if available.
- [ ] Implement diagnostics routing so Biome-supported paths use Biome, Python type diagnostics use ty, Python lint diagnostics use Ruff, and Python `checker: "all"` runs both; verify multi-route output is understandable.
- [ ] Implement format routing so Biome-supported files use Biome and Python files use Ruff; verify unsupported extensions produce a clear error.
- [ ] Implement fix routing so Biome-supported files use Biome and Python files use Ruff, preserving adapter default fix kinds and explicit `kind` passthrough.
- [ ] Update tool descriptions and prompt guidelines in `pi-lsp.ts` to explain language/file-extension routing and Python checker choices.
- [ ] Update `extensions/pi-lsp/README.md` with new tool examples, classification rules, unchanged environment variables, and migration table; verify old names appear only in intentional migration notes.
- [ ] Update related docs such as `docs/implementation-notes/pi-lsp-parity-checklist.md` if they still name old tools; verify with `rg "biome_lsp_|ty_lsp_|ruff_lsp_" extensions/pi-lsp docs --glob '!docs/plans/**'`.
- [ ] Decide release handling for the breaking public tool API; verify by documenting whether this implementation only changes source/docs or also requires a major version bump through the repository release workflow.
- [ ] Run static checks from the repository root; verify with `npm run check`.
- [ ] Preview package contents; verify with `just pack-lsp` and inspect the tarball file list.

## Risks

- Removing old names may break saved prompts, workflows, or users that call the seven old tools directly.
- Defaulting Python diagnostics to both ty and Ruff may increase latency or produce more noise.
- Directory diagnostics over mixed projects may produce confusing multi-backend output unless summaries identify the selected route.
- Optional `language` overrides can contradict file extensions; validation must prefer clear errors over surprising routing.

## Rollback / Recovery

- If language/file-extension routing is confusing, keep the three action-level tool names but require a backend/checker selector temporarily.
- If the breaking tool-name change is too disruptive, reintroduce the seven old names as deprecated aliases that call the new routing helper, and document a migration window.
- If multi-route diagnostics are too slow, change the Python default from `checker: "all"` to an explicit required checker or a cheaper default.

## Completion Checklist

- [ ] Public tool surface is `lsp_diagnostics`, `lsp_format`, and `lsp_fix`, verified by code review or non-interactive local extension inspection.
- [ ] Language/file-extension routing is centralized in a bounded helper, verified by review of `extensions/pi-lsp/src/`.
- [ ] Biome-supported extensions route to Biome for diagnostics/format/fix, verified by adapter predicate reuse and README examples.
- [ ] Python `.py`/`.pyi` diagnostics route to ty, Ruff, or both according to the chosen checker API, verified by schema and dispatch code review.
- [ ] Python format/fix routes only to Ruff, verified by schema or route validation preventing ty format/fix.
- [ ] Unsupported extensions and contradictory overrides produce clear errors, verified by route validation review or runtime smoke test.
- [ ] Documentation explains classification and migration from old tool names, verified by scoped `rg` showing only intentional old-name references.
- [ ] Repository quality gates pass, verified by `npm run check`.
- [ ] Package dry run is clean, verified by `just pack-lsp`.
