# Repository Guidelines

## Documentation and communication

- Lead with the most important relevant information, then add only necessary detail.
- Use clear, familiar words and concise, accurate sentences without repetition.
- Explain the main idea simply before adding technical detail.
- Make documented rules specific and verifiable.
- Write one sentence per source line in prose.

## Repository structure

- This Node.js and TypeScript monorepo contains Pi extension packages, project-local Pi extensions, and reusable libraries.
- Keep publishable extension packages and reusable libraries under `packages/<package>/`.
- Keep package implementation source under `packages/<package>/src/`.
- Keep small repository-only Pi extensions and their supporting implementation files under `.pi/extensions/<extension>/`, with `index.ts` as the entrypoint.
- Each package owns its manifest, README, license, and TypeScript configuration.
- Set each extension package's `piExtension.lifecycle` to `stable` or `experimental`.
- Treat `.pi/extensions/` as a self-contained project-resource boundary unrelated to extension packages under `packages/`.
- Keep a project-local extension's implementation, helpers, documentation, and any requested tests inside its own `.pi/extensions/<extension>/` directory.
- Do not add or modify package manifests, workspaces, Changesets, package tests, root test support, or shared TypeScript configuration for a project-local extension unless the user explicitly asks.
- Project-local extensions do not require package manifests, lifecycle metadata, Changesets, publication files, or packaged-extension verification gates.
- Promote a project-local extension into `packages/` only when the user explicitly requests independent installation, reuse, versioning, or publication.
- Omit `piExtension` from reusable libraries.
- Keep deprecated reference packages under `deprecated/`, which active checks exclude.
- Root files such as `package.json`, `package-lock.json`, `biome.json`, `tsconfig.json`, `justfile`, and `.github/workflows/*` own shared tooling.
- Never edit `node_modules/`.
- Read `node_modules/` to confirm external API types and usage instead of guessing.
- Keep published files aligned with each manifest's `files` list and `pi.extensions` entry.

## Commands

Run commands from the repository root unless a command says otherwise.

- Run `npm install` to install dependencies.
- Run `npm run format` or `just format` to format with Biome.
- Run `npm run typecheck` to typecheck every workspace.
- Run `just --list` before adding or documenting a workflow command.
- Put repository workflows intended for manual use in `justfile`, and keep recipes as thin command entrypoints.
- Put complex Bash or TypeScript workflow implementations under `scripts/`, then invoke them from recipes or automation.
- Keep npm scripts as composable package and automation primitives.

## Tooling and dependency safety

- Do not run root checks and the `pi-tui-kit` build or check concurrently because both clear `packages/pi-tui-kit/dist`.
- Rebuild `pi-tui-kit` before consumer tests because consumers resolve its built output.
- After raising a consumer's Kit floor, run root `npm install`, then use `npm ls @narumitw/pi-tui-kit` to verify the resolved version before typechecking.
- Keep imported Pi packages as root devDependencies so tests compiled beneath root `node_modules/.cache` resolve the intended versions.
- Prefer Pi AI root exports; use a variable-specifier dynamic import only when a required subpath has no root export because official Pi can misresolve static `@earendil-works/pi-ai/api/*` imports.
- Treat Pi's user and project managed npm roots as separate install scopes because deduplication is guaranteed only within one root.
- Never use `npm audit fix --force`; if it alters Pi dependencies, restore every workspace manifest and the lockfile, then use targeted patched upgrades or overrides.

## Code and package rules

- Follow KISS and YAGNI: prefer simple, minimal solutions and avoid unnecessary complexity.
- Root TypeScript uses NodeNext modules, ES2022, strict mode, and no emit.
- Biome requires tabs, double quotes, semicolons, a 100-column line width, and recommended lint rules.
- Add dependencies only for current package needs.
- Use a Pi core function when Pi already provides the required behavior.
- Upgrade an outdated dependency instead of hiding its type errors by removing or downgrading code.
- Keep every extension package independently installable and functional by itself.
- Keep every project-local extension functional through Pi's project auto-discovery without another extension package.
- Do not import or depend on another extension package.
- Do not assume private or extension-specific details of another extension, including its names, schemas, settings, events, installation state, version, or behavior.
- Extensions may participate in documented, versioned, extension-neutral protocols over Pi's public APIs only when the protocol does not identify or require a specific extension and the absence of other participants preserves standalone behavior.
- Keep each behavior policy in the extension that enforces it.
- Share code only through Pi's public extension-neutral APIs or reusable non-extension libraries.
- Do not make reusable libraries coordinate specific extensions.
- Consume shared Pi APIs without extension-specific branches.
- Give every packaged extension a thin `src/index.ts` default-export forwarder and keep authoritative implementation under `src/`.
- A project-local extension may use `.pi/extensions/<extension>/index.ts` as its authoritative implementation.
- Declare exactly one extension entrypoint in each packaged extension manifest: `./src/index.ts`, or a build-backed `./dist/index.ts` TypeScript bundle loaded by Pi's Jiti runtime.
- Require a `dist/index.ts` entrypoint to stay within `dist`, externalize Pi-bundled peer dependencies, publish `dist`, and be built before packing or loading the package directory.
- Require generated runtimes to validate that every static or dynamic relative import resolves to the exact emitted file path and extension; when a runtime has lazy chunks, exercise a lazy boundary through Pi's Jiti loader instead of stopping at entry load.
- Keep extension implementation in descriptively named source modules.
- Build and publish reusable libraries as JavaScript with declarations through their own build configuration and without `pi.extensions`.
- Run `npm run check:boundaries` to verify package boundaries.
- List every stable extension package's `src/index.ts` repository entrypoint in the root `package.json` under `pi.extensions`.
- Do not list experimental extension package entrypoints in the root `package.json` under `pi.extensions`.
- Do not list `.pi/extensions/` entrypoints in the root `package.json`; Pi discovers them after the project is trusted.
- Add a root workspace script or recipe only for a workflow users must run from the repository root.
- Choose the first TUI layer that fully supports the flow: Pi core `ctx.ui` APIs and `@earendil-works/pi-tui` components, then `@narumitw/pi-tui-kit`, and finally an extension-owned custom component.
- Create a new custom component only when the earlier layers cannot preserve the required state, interaction, or lifecycle behavior.
- Keep domain state, persistence, confirmations, and specialized UI inside the owning extension.
- Preserve each README's emoji title; npm, Pi, and license badges; and applicable `✨ Features`, `📦 Install`, `🚀 Quick start`, `⚙️ Settings`, `💬 Commands`, `🗂️ Package layout`, `🔎 Keywords`, and `📄 License` sections.
- Show a user-facing warning for experimental extensions and features.
- Keep experimental packages in root checks unless they are private.
- Gate an experimental feature inside a stable package with explicit configuration that defaults to the existing stable behavior.
- Split source files over 1,000 lines by clear responsibilities or document why they must stay intact.
- Do not mechanically split generated, vendored, migration, snapshot, or mainly declarative files.

## Extension change gates

- Read `docs/extension-conventions.md` completely before planning or editing extension metadata, lifecycle, commands, menus, TUI, status, documentation, or verification behavior.
- Read `docs/extension-settings.md` completely before changing extension-owned settings, persistence, validation, precedence, migration, commands, or UI.
- Before implementation, list each touched area with its applicable **MUST** rules and named verification methods.
- Audit user cancellation, component disposal, session replacement, and shutdown for every asynchronous UI or lifecycle flow.
- Cancel or release every task owned by the flow.
- Revalidate stale sessions, generations, contexts, and mutable state after each `await`.
- Audit settings reads and writes together for ordering, failure recovery, stale reads, invalid-file protection, unknown-field preservation, and atomic publication.
- Audit the final diff against the guides' touched-area and verification checklists.
- Do not use a passing `npm run check` as a substitute for the semantic audit.
- When review finds one convention failure, inspect the whole pull-request diff for the same failure class.
- Name the guides, audits, checks, smokes, deviations, and unverified paths in the handoff.

## Runtime and lifecycle constraints

- Do not call Pi action methods such as `getThinkingLevel()` during extension factory load; defer them until `session_start` or later.
- Preserve the serialized model-visible system prompt, ordered active tool definitions, and existing message prefix across ordinary turns; append new context at the conversation tail and document and test every intentional prefix transition.
- Lazy-load extension tools only through Pi's purely additive `pi.setActiveTools()` deferred-loading path, and never remove or replace active tools in the activation call.
- Enable tool lazy loading only when the selected model and provider support Pi's native deferred protocol; otherwise expose the configured tools before the next model request and never use Pi's cache-invalidating fallback.
- Keep the loader active for the session and omit `promptSnippet` and `promptGuidelines` from lazily loaded tools so activation preserves the stable system-prompt prefix.
- Treat `agent_end` as a run boundary and `agent_settled` as the idle boundary for retries, final cleanup, and next-item activation.
- Persist non-model state with `pi.appendEntry()` or tool-result `details`; inject a required compaction-sensitive model contract through one deterministic, deduplicated `context` hook block only after the original handoff disappears.
- Key headless session-owned resources by `sessionManager`, not `ctx.ui`, because headless runners can share one no-op UI object.

## TUI and rendering safety

- When custom TUI extends or replaces a Pi UI API or component, preserve the layout, theme hierarchy, keybindings, editing semantics, and cancellation behavior demonstrated by the installed implementation and existing tests.
- Document an intentional compatibility deviation in the package README or an adjacent code comment.
- Use callback-provided theme roles instead of hard-coded terminal colors, and render secondary descriptions and key hints with a muted theme role.
- Show selection cursors and highlights only for content that users can activate, and render read-only reviews or summaries without selection affordances.
- Use callback-provided keybindings for standard actions, derive displayed key hints from the effective bindings, and give configured standard actions priority over additive shortcuts.
- Keep `Ctrl+C` available as a hard-cancel path in dismissible custom flows even when configurable cancellation is remapped.
- Preserve Pi's Backspace, newline, submission, and paste behavior when embedding `Input` or `Editor`, and ensure screen-level shortcuts respect input focus and paste state.
- Test custom key handling with at least one non-default keybinding set, and test changed review or editor behavior for non-interactive rendering or editing and paste behavior respectively.
- Treat model IDs, session text, paths, and pasted search text as untrusted terminal input.
- Strip terminal controls at the display boundary without mutating raw payloads, and sanitize before path splitting, filtering, wrapping, or truncation.
- Do not use `wrapTextWithAnsi` for exact code or text previews because it trims whitespace at word-wrap boundaries; use cell-aware hard wrapping or horizontal scrolling.
- Use `Editor.getExpandedText()` when moving a draft outside an editor because `getText()` can retain large-paste markers.
- Initialize a theme and dispose the loader harness in tests that construct `BorderedLoader`.
- Capture evidence inside mocked `ctx.ui.custom()` callbacks and assert after command completion because callback assertions can be caught as menu errors.

## Testing and verification

- Keep active tests under `packages/<package>/test/*.test.ts` and run them with `npm test`.
- Keep archived tests under `deprecated/` and outside active checks.
- Keep every Vitest test within a 5,000 ms hard timeout, never add a larger per-test override, and split or synchronize a slow test instead of raising the limit.
- Set the Bash tool timeout to 300 seconds.
- Run `npm run check` or `just check` for the build, Biome, boundaries, and workspace typechecks.
- Run `npm test` or `just test` separately for active tests.
- CI and release verification must run both gates.
- Run `just pack <unscoped-name>` and inspect the tarball after package metadata or publishing changes.
- After packaged extension runtime-loading changes, run `npm --workspace @narumitw/pi-<unscoped-name> run build --if-present`, then smoke with `pi -e ./packages/pi-<unscoped-name>`; record why and what remains unverified if the smoke is impractical.
- After project-local extension changes, smoke it in isolation with `pi --no-extensions -e ./.pi/extensions/<extension>/index.ts`, then verify trusted-project auto-discovery and `/reload` when practical.
- Start subprocess timing deadlines only after a child readiness handshake.
- Synchronize concurrent HTTP tests on a server-observable response or callback instead of a fixed sleep after `fetch()`.
- Set `PI_CODING_AGENT_DIR` before importing an extension in lifecycle tests and use fresh imports for module-cached paths.
- Disable `commit.gpgsign` only through command-scoped Git configuration when root tests cannot reach a signing agent.
- Keep worktrees outside the repository because root Biome checks reject nested worktrees with another `biome.json`.
- Put generated-path ignores in the root `.gitignore`; never blanket-ignore `src/`.
- For relevant live-provider smokes, stop after one clear external or entitlement failure and fall back to deterministic tests unless the user asks to retry.

## Publishing and release safety

- Get explicit user approval before publishing, changing npm visibility, creating version tags, or dispatching release workflows.
- Version every publishable package independently through Changesets.
- Add a changeset when a pull request changes published package behavior.
- Repository-only documentation, tests, tooling, and path migrations may omit a changeset.
- Release experimental packages through the same Changesets workflow as stable packages.
- Preserve experimental warnings in documentation and runtime behavior.
- Use `just npm-public <package>` only to change the visibility of an existing package.
- Use `npm publish --workspace <package> --access public` only for the explicitly approved first publication of a new scoped package that still returns 404.
- Except for that initial-publication exception, let `publish.yml` manage the version pull request, package tags, publications, and GitHub releases.
- Publish a new `pi-tui-kit` API before raising its first consumer's compatibility floor, and do not release the API with that consumer.

## Git and pull requests

- Inspect the selected diff and keep each commit focused on one intent.
- Use `<type>[scope][!]: <description>` based on the actual diff.
- Prefer `feat`, `fix`, `refactor`, or `docs`, and omit unused scope, body, or footers.
- Stage only intended paths, recheck the index, reject empty commits, and report the commit ID and remaining changes.
- Include completed checks and any relevant publish or visibility evidence in pull-request or handoff notes.

## Working preferences

- Prefer `gh --json` for GitHub issue and pull-request links; use web tools only when `gh` cannot expose the required content.
- Keep a predecessor extension active until an explicit follow-up decision approves deprecation.
- Keep package versions out of long-lived guidance and derive them from manifests, lockfiles, or workflows.
- Require a clean worktree before dependency-maintenance recipes.
- Use Git-based recovery instead of embedding rollback logic in `just` recipes.
- Make `just` install recipes verify registry visibility first and fall back to the local workspace only when that fixes the current install path.
