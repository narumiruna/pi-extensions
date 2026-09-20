# Generated-runtime builder

`scripts/runtime-builder.mjs` owns repository build policy; package wrappers own entrypoints, banners, temporary-directory prefixes, eager boundaries, and focused validators. It is not a published runtime dependency. Generated packages continue to load without this repository tooling.

## Scope and verification

The applicable guide is `docs/extension-conventions.md`, especially **Build-backed Jiti runtimes** and **Documentation and verification**.

| Touched area | MUST rules | Verification |
| --- | --- | --- |
| Bundling | Externalize package imports, preserve dynamic boundaries and exact emitted import paths | Metafile comparison, shared contract, parsed generated imports, package Jiti tests |
| Build output | Deterministic source-mapped staging; validate before publication; remove stale files; restore prior output after failure | SHA-256 baseline comparison, shared failure-injection tests |
| Package loading | Preserve standalone entrypoints, registration, lazy activation and lifecycle | Existing package-local generated-entry tests and package-directory Pi smokes |
| Repository tooling | Keep package-specific policy local; no published builder dependency | Diff and manifest review; root builds, boundaries, typechecks and tests |

No runtime source, settings, commands, UI, model-visible prefix, dependency, or publication metadata changes are intended. Existing lifecycle and cancellation tests remain local. No Changeset is needed for output-equivalent repository tooling.

## Variation audit

All 29 original builders were compared with `pi-analytics` after normalizing only the package-specific temporary names. Shared behavior includes the esbuild options, staging, dependency exclusion, static eager traversal, banners/maps, owned output paths, cleanup, and backup/rename recovery.

`Kit` below means `@narumitw/pi-tui-kit`. The wrappers retain the complete literal input lists. All migrated wrappers keep their original banner, staging prefix and test-output prefix.

| Package(s) | Package-owned differences | Classification / disposition |
| --- | --- | --- |
| pi-analytics, pi-btw, pi-file-context, pi-firecrawl, pi-github-pr, pi-lsp, pi-usage, pi-worktree | No forbidden eager source; forbid Kit and subpaths | Declarative; migrate |
| pi-accounts | Account menu lazy | Declarative; migrate |
| pi-context-management | Settings menu lazy | Declarative; migrate |
| pi-caffeinate | Also forbid eager dbus-native | Declarative; migrate |
| pi-chat | Network, directory, menu, chat-view and widget lazy; alternate banner | Declarative; migrate |
| pi-chrome-devtools | Menus and WebMCP modules lazy; alternate banner | Declarative; migrate |
| pi-codex-compact | Settings menu lazy; alternate banner | Declarative; migrate |
| pi-fleet | Menu lazy; alternate banner | Declarative; migrate |
| pi-goal | Menu and settings UI lazy; alternate banner | Declarative; migrate |
| pi-herdr | Menu lazy; allow two exact Kit presentation leaves | Declarative; migrate |
| pi-plan-mode | Seven UI modules lazy; alternate banner | Declarative; migrate |
| pi-progress, pi-typesafe-search | No forbidden eager externals | Declarative; migrate |
| pi-recall | Menu and picker lazy; alternate banner | Declarative; migrate |
| pi-stamp | Menu lazy; allow exact Kit terminal-text leaf; no standalone .js-file guard | Declarative; migrate with shared generated-file validation |
| pi-starship | Eleven command/collector modules lazy; exact Kit/yaml bans include dynamic external edges; reject call-time createRequire | Declarative graph policy and focused file validator; migrate |
| pi-statusline | Commands lazy; exact Kit ban includes dynamic external edges; alternate banner | Declarative; migrate |
| pi-subagents | Two named entries, distinct banner; reject non-src inputs and eagerly reachable child bridge; require bridge path literal | Declarative entries and focused graph/file validators; migrate |
| pi-sync | Seventeen first-use inputs must exist and remain lazy; Kit/parser subpath bans include dynamic external edges; parsed import validation; no public rename seam | Declarative boundaries and focused graph validator; migrate; share parsed validation and publication seam |
| pi-ticker | Two menus lazy; forbid only exact Kit root, permit subpaths and dynamic external edges; validate all relative import extensions | Declarative; migrate with shared parsed import validation |
| pi-tool | Catalog lazy; alternate banner | Declarative; migrate |
| pi-langfuse | Separate TypeScript and JavaScript graphs, library-chunks, tsc declaration generation, cross-graph and declaration validation | Retain local builder and all tests: migration would require a second build pipeline/declaration hook used by no other package |

Parsed, non-bundling esbuild validation replaces import-like string matching in migrated builders. Every actual relative static import, re-export and dynamic import must target an emitted `.ts` runtime exactly. Ordinary strings are not imports. Stray `.js` output is rejected consistently, including the old stamp/sync gaps. These checks do not alter emitted output.

## Builder contract

`createRuntimeBuilder` accepts only confirmed wrapper variations: package root, temporary prefix, banner, optional named entries, forbidden eager inputs/externals, exact allowed externals, external subpath/dynamic matching, and additive graph/file validators. It does not accept arbitrary esbuild options or build callbacks. The default build remains split ESM, ES2022, external packages, `.ts` JavaScript output and source maps.

Package graph validators receive normalized input sets and the main eager graph. File validators receive the staged directory and runtime inventory after common validation. They cannot replace the common policy. The per-build `validateOutput` seam supports failure injection after normal validation.

Only `dist` and the wrapper's test-output prefix are writable. Staging must be a build-owned sibling, and symlink outputs, staging links and parent aliases are rejected. Output ownership is checked again after validation. Publication preserves the previous directory until staging validates, restores it if the final rename fails, and retains a recovery backup if restoration itself fails. This is same-filesystem rename publication, not a cross-process lock or crash-durable transaction; concurrent builds of one destination are not supported.

## Migration evidence

Baseline: `130ded9e`, clean worktree, all workspace builds successful, 29 builder test files and 158 tests passing. Temporary snapshots record every generated file hash, parsed import, output metafile and main eager graph. Migration comparisons are performed in small groups before proceeding.

All 28 migrated runtimes (250 generated files) match the baseline byte-for-byte, including maps, parsed imports, normalized output metafiles, eager inputs and externals. Comparisons passed after groups of 8, 7, 8 and 5 migrations and after the final build; Langfuse output also remains unchanged. The sorted `[package, path, SHA-256]` inventory digest is `5911d3cfbb4f6a1b0eb0c3ccc91a563d2004d064bfbed02c3bff1f7a809fa78d`.

Verification passed:

- `npx vitest run test/runtime-builder.test.ts packages/*/test/build-runtime.test.ts`: 30 files, 204 tests, unchanged 5,000 ms limit.
- `npm run typecheck`, `npm run check`, and plain `npm test`: 445 files, 5,147 tests.
- Each migrated workspace's explicit build, followed by `pi --no-extensions --no-skills -e ./packages/pi-<name> --list-models` with isolated agent directories: 28 successful loads.
- `npm pack --workspace <name> --dry-run --json` for all 28 migrated packages: generated entries, every generated file and licenses present; build scripts excluded.
- Package-local Jiti tests cover simple analytics loading; lazy stamp, ticker and sync flows; subagents' separate credential-backed child entry; and starship's specialized resolution validator. Existing source-graph, session replacement and shutdown tests remain local.

Semantic review covered all wrapper variations, exact imports, peer externalization, deferred boundaries, stale-output removal, destructive paths, symlink aliases, cleanup and restoration. Thirty-four retained package-specific test ASTs are unchanged; source-map and bridge tests retain their specialized assertions without generic duplication. Runtime source, manifests, dependencies, settings, commands, UI and prompt behavior are unchanged.

The parser and ownership checks deliberately close validation gaps without changing generated output. No release, visibility change or live-provider request is required. Checks ran on Linux; Windows/macOS behavior, simultaneous writers and crash durability were not newly verified. The latter two remain outside the builder contract.
