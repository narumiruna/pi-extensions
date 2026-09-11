# Repository Guidelines

## Documentation

- Lead with the most important information and use concise, accurate prose without repetition.
- Use concise paragraphs for human-facing narrative and lists only when separate items are easier to scan.
- Keep `AGENTS.md` instructions as one-sentence, enforceable bullet points.
- Follow `docs/readme-conventions.md` for active package READMEs, including its required sections, warnings, scope rules, and verification checklist.
- Keep package versions out of long-lived guidance and derive them from manifests, lockfiles, or workflows.

## Code style

- Follow KISS and YAGNI, add dependencies only for current needs, and use Pi core functions when they already provide the required behavior.
- Use NodeNext modules, ES2022, strict TypeScript, and no emit for root TypeScript.
- Upgrade outdated dependencies instead of removing or downgrading valid code to hide their type errors.
- Split source files over 1,000 lines by clear responsibility, but do not mechanically split generated, vendored, migration, snapshot, or mainly declarative files.

## Commands and tooling

- Run commands from the repository root unless their documentation says otherwise.
- Use `npm install` to install dependencies, `npm run format` to apply Biome formatting, and `npm run typecheck` to typecheck every workspace.
- Run `npm run` before adding or documenting a root workflow command.
- Keep root npm scripts as canonical entrypoints only for workflows users run from the root, and move complex implementations under `scripts/`.
- Keep pre-commit hook logic in `scripts/pre-commit.sh`, invoke it directly from `.husky/pre-commit`, and do not add a duplicate root npm script.
- Do not run root checks concurrently with a `pi-tui-kit` build or check because both clear `packages/pi-tui-kit/dist`.
- Rebuild `pi-tui-kit` before consumer tests because consumers resolve its built output.
- After raising a consumer's Kit floor, run root `npm install`, verify the resolution with `npm ls @narumitw/pi-tui-kit`, and then typecheck.
- Keep imported Pi packages in root `devDependencies` so tests emitted under `node_modules/.cache` resolve the intended versions.
- Prefer Pi AI root exports, and use a variable-specifier dynamic import only when a required subpath has no root export because official Pi can misresolve static `@earendil-works/pi-ai/api/*` imports.
- Treat Pi's user and project managed npm roots as separate install scopes because deduplication is guaranteed only within one root.
- Never use `npm audit fix --force`; if it changes Pi dependencies, restore every workspace manifest and the lockfile before applying targeted patched upgrades or overrides.

## Boundaries and package layout

- Keep publishable extension packages and reusable libraries under `packages/<package>/`, with implementation source under `packages/<package>/src/`.
- Keep deprecated references under `deprecated/`, which active checks exclude.
- Keep each package's manifest, README, license, and TypeScript configuration inside that package.
- Preserve each README's emoji title; npm, Pi, and license badges; and applicable `✨ Features`, `📦 Install`, `🚀 Quick start`, `⚙️ Settings`, `💬 Commands`, `🗂️ Package layout`, `🔎 Keywords`, and `📄 License` sections.
- Treat every active packaged extension uniformly and do not add repository-specific lifecycle classifications.
- Keep small repository-only extensions and their helpers, documentation, and requested tests under `.pi/extensions/<extension>/`, with `index.ts` as the entrypoint.
- Treat `.pi/extensions/` as a self-contained project-resource boundary unrelated to packages under `packages/`.
- Do not add package manifests, workspaces, Changesets, package tests, root test support, or shared TypeScript configuration for a project-local extension unless the user explicitly asks.
- Promote a project-local extension into `packages/` only when the user explicitly requests independent installation, reuse, versioning, or publication.
- Keep shared tooling in root files such as `package.json`, `package-lock.json`, `biome.json`, `tsconfig.json`, and `.github/workflows/*`.
- Never edit `node_modules`; inspect its installed implementations when code mirrors, filters, or predicts external runtime behavior.
- When matching external runtime behavior, enumerate every relevant decision branch and equivalence class instead of inferring behavior from types, raw values, or review examples.
- Keep every packaged extension independently installable and every project-local extension functional through auto-discovery without another extension package.
- Do not import, depend on, identify, or assume private details of another extension.
- Allow only documented, versioned, extension-neutral protocols over Pi public APIs when absent participants preserve standalone behavior.
- Keep each behavior policy in the extension that enforces it, and share code only through Pi public APIs or reusable non-extension libraries.
- Do not make reusable libraries coordinate specific extensions or consume shared Pi APIs through extension-specific branches.
- Give each packaged extension a thin `src/index.ts` default-export forwarder and keep authoritative implementation in descriptively named source modules.
- Declare exactly one extension entrypoint in each package manifest: `./src/index.ts` or a build-backed `./dist/index.ts` TypeScript bundle loaded by Pi's Jiti runtime.
- Keep a `dist/index.ts` entrypoint within `dist`, externalize Pi-bundled peer dependencies, publish `dist`, and build it before packing or loading the package directory.
- Validate every generated runtime's static and dynamic relative imports against exact emitted paths and exercise a representative lazy boundary through Pi's Jiti loader.
- Build reusable libraries as JavaScript with declarations through package-owned configuration and without `pi.extensions`.
- List every active extension package's `src/index.ts` repository entrypoint in root `package.json` under `pi.extensions`.
- Do not list `.pi/extensions/` entrypoints in root `package.json` because Pi discovers them after project trust.
- Keep published files aligned with each manifest's `files` list and `pi.extensions` entry.
- Put generated-path ignores in root `.gitignore` and never blanket-ignore `src/`.

## Extension change workflow

- Read `docs/extension-conventions.md` completely before planning or editing extension metadata, lifecycle, commands, menus, TUI, status, documentation, or verification behavior.
- Read `docs/extension-settings.md` completely before changing extension-owned settings, persistence, validation, precedence, migration, commands, or UI.
- Before implementation, list each touched area with its applicable **MUST** rules and named verification methods.
- Audit the final diff against the guides' touched-area and verification checklists instead of treating a passing `npm run check` as a semantic audit.
- Audit user cancellation, component disposal, session replacement, and shutdown for every asynchronous UI or lifecycle flow, and cancel or release every owned task.
- Revalidate session, generation, context, ownership, and mutable state after every `await` where they can become stale.
- Audit settings reads and writes together for ordering, failure recovery, stale reads, invalid-file protection, unknown-field preservation, and atomic publication.
- When review identifies one failure class, derive the complete class from authoritative code, audit the whole pull-request diff for every occurrence, and verify representative tests before replying or resolving the thread.
- Name the applicable guides, semantic audits, checks, smokes, deviations, and unverified paths in the handoff.

## Runtime and lifecycle safety

- Do not call Pi action methods such as `getThinkingLevel()` during factory load; defer them until `session_start` or later.
- Preserve the serialized model-visible system prompt, ordered active tool definitions, and existing message prefix across ordinary turns, and append new context at the conversation tail.
- Document and test every intentional model-visible prefix transition.
- Lazy-load extension tools only through Pi's purely additive `pi.setActiveTools()` deferred path, and never remove or replace active tools during activation.
- Enable lazy loading only when the selected model and provider support Pi's native deferred protocol; otherwise expose configured tools before the next request without Pi's cache-invalidating fallback.
- Keep a lazy loader active for the session and omit `promptSnippet` and `promptGuidelines` from lazily loaded tools.
- Treat `agent_end` as a run boundary and `agent_settled` as the idle boundary for retries, final cleanup, and next-item activation.
- Persist non-model state with `pi.appendEntry()` or tool-result `details`, and restore a required compaction-sensitive model contract through one deterministic, deduplicated `context` hook block only after the original handoff disappears.
- Key headless session-owned resources by `sessionManager`, not `ctx.ui`, because headless runners can share one no-op UI object.

## TUI and rendering safety

- Choose the first layer that fully supports the flow: Pi `ctx.ui` APIs and `@earendil-works/pi-tui`, then `@narumitw/pi-tui-kit`, and finally an extension-owned custom component.
- Keep domain state, persistence, confirmations, and specialized UI inside the owning extension.
- Preserve Pi's demonstrated layout, theme hierarchy, keybindings, editing semantics, cancellation behavior, and non-interactive rendering when custom UI extends or replaces a Pi component.
- Document intentional compatibility deviations in the package README or an adjacent code comment.
- Use callback-provided theme roles and keybindings, render secondary descriptions and key hints with a muted role, and prioritize configured standard actions over additive shortcuts.
- Show cursors and highlights only for activatable content, not read-only reviews or summaries.
- Before displaying a custom key hint, prove it can match input and is not consumed by an earlier listener under the effective keybindings and terminal mode.
- Keep `Ctrl+C` as a hard-cancel path in dismissible custom flows even when configurable cancellation is remapped.
- Preserve Pi's Backspace, newline, submission, and paste behavior when embedding `Input` or `Editor`, and make screen shortcuts respect input focus and paste state.
- Use `Editor.getExpandedText()` when moving a draft outside an editor because `getText()` can retain large-paste markers.
- Treat model IDs, session text, paths, and pasted search text as untrusted terminal input.
- Strip terminal controls at the display boundary without mutating raw payloads, and sanitize before path splitting, filtering, wrapping, or truncation.
- Use cell-aware hard wrapping or horizontal scrolling for exact previews because `wrapTextWithAnsi` trims whitespace at word-wrap boundaries.
- Initialize a theme and dispose the loader harness in tests that construct `BorderedLoader`.
- Capture evidence inside mocked `ctx.ui.custom()` callbacks and assert it after command completion because callback assertions can be caught as menu errors.

## Testing and verification

- Keep root integration tests under `test/`, package tests under `packages/<package>/test/*.test.ts`, and archived tests under `deprecated/`.
- Keep every Vitest test within the configured 5,000 ms timeout, and split or synchronize slow tests instead of adding a larger per-test override.
- Test custom key handling with at least one non-default keybinding set.
- Test changed reviews in non-interactive rendering and changed editors for editing and paste behavior.
- Use table-driven custom-keybinding tests that cover matcher aliases, modifier order, legacy input collisions, terminal-mode differences, invalid configured strings, and the first usable fallback.
- Run `npm run check` for builds, Biome, package boundaries, and workspace typechecks.
- Run `npm test` separately for active root and workspace tests; CI must run both gates, while `publish.yml` must not rerun them.
- Run `npm run package:pack -- <unscoped-name>` and inspect the tarball after package metadata or publishing changes.
- After packaged runtime-loading changes, run `npm --workspace @narumitw/pi-<unscoped-name> run build --if-present` and smoke with `pi -e ./packages/pi-<unscoped-name>`.
- After project-local extension changes, smoke with `pi --no-extensions -e ./.pi/extensions/<extension>/index.ts`, then verify trusted-project auto-discovery and `/reload` when practical.
- Record why any required smoke is impractical and what remains unverified.
- Start subprocess timing deadlines only after a child readiness handshake, and synchronize concurrent HTTP tests on a server-observable response or callback instead of a fixed sleep.
- Set `PI_CODING_AGENT_DIR` before importing an extension in lifecycle tests and use fresh imports for module-cached paths.
- Disable `commit.gpgsign` only through command-scoped Git configuration when root tests cannot reach a signing agent.
- Keep worktrees outside the repository because root Biome checks reject nested worktrees with another `biome.json`.
- Stop after one clear external or entitlement failure in a live-provider smoke and fall back to deterministic tests unless the user asks to retry.

## Publishing and release safety

- Get explicit user approval before publishing, changing npm visibility, creating version tags, or dispatching release workflows.
- Version publishable packages independently through Changesets and add a changeset when a pull request changes published behavior.
- Repository-only documentation, tests, tooling, and path migrations may omit a changeset.
- Preserve user-facing experimental warnings and gate experimental behavior behind explicit configuration that defaults to existing behavior.
- Keep a predecessor extension active until an explicit follow-up decision approves deprecation.
- Use `npm run package:public -- <package>` only to change an existing package's visibility.
- Use `npm publish --workspace <package> --access public` only for an explicitly approved first publication of a new scoped package that still returns 404.
- Except for that first-publication case, let `publish.yml` manage version pull requests, package tags, publications, and GitHub releases.
- Require a clean worktree before dependency-maintenance workflows and use Git recovery instead of embedding rollback logic in workflow scripts.
- Make package-install workflows verify registry visibility first and fall back to the local workspace only when that fixes the current install path.

## Git and pull requests

- Prefer `gh --json` for GitHub issue and pull-request data, and use web tools only when `gh` cannot expose the required content.
- Inspect the selected diff and keep each commit focused on one intent.
- Use `<type>[scope][!]: <description>` based on the actual diff, preferring `feat`, `fix`, `refactor`, or `docs` and omitting unused scope, body, or footers.
- Stage only intended paths, recheck the index, reject empty commits, and report the commit ID and remaining changes.
- Include completed checks and relevant publication or visibility evidence in pull-request and handoff notes.
