# Repository Guidelines

## Documentation and communication

- Keep documents and conversations concise, clear, and accurate.
- Explain things simply enough for a child to understand.
- Write one sentence per line in prose.

## Repository structure

- This Node.js and TypeScript monorepo contains Pi extensions and reusable libraries.
- Keep active package source under `packages/<package>/src/`.
- Each package owns its manifest, README, license, and TypeScript configuration.
- Set each extension's `piExtension.lifecycle` to `stable` or `experimental`.
- Omit `piExtension` from reusable libraries.
- Keep deprecated reference packages under `deprecated/`, which active checks exclude.
- Root files such as `package.json`, `package-lock.json`, `biome.json`, `tsconfig.json`, `justfile`, and `.github/workflows/*` own shared tooling.
- Never edit `node_modules/`.
- Read `node_modules/` to confirm external API types and usage instead of guessing.
- Keep published files aligned with each manifest's `files` list and `pi.extensions` entry.

## Commands

Run commands from the repository root unless a command says otherwise.

- Run `npm install` to install dependencies.
- Run `npm run check` or `just check` for the CI-equivalent verification gate.
- Run `npm test` to execute all active tests.
- Run `npm run format` or `just format` to format with Biome.
- Run `npm run typecheck` to typecheck every workspace.
- Run `just pack <unscoped-name>` to preview a package.
- Run `just try <unscoped-name>` to test a local extension in Pi.
- Run `just --list` before adding or documenting a workflow command.

## Tooling and dependency safety

- Do not run root checks and the `pi-tui-kit` build or check concurrently because both clear `packages/pi-tui-kit/dist`.
- Rebuild `pi-tui-kit` before consumer tests because consumers resolve its built output.
- After raising a consumer's Kit floor, run root `npm install` and verify the resolved consumer version before typechecking.
- Keep imported Pi packages as root devDependencies so tests compiled beneath root `node_modules/.cache` resolve the intended versions.
- Prefer Pi AI root exports; use a variable-specifier dynamic import only when a required subpath has no root export because official Pi can misresolve static `@earendil-works/pi-ai/api/*` imports.
- Treat Pi's user and project managed npm roots as separate install scopes because deduplication is guaranteed only within one root.
- Never use `npm audit fix --force`; if it alters Pi dependencies, restore every workspace manifest and the lockfile, then use targeted patched upgrades or overrides.

## Code and package rules

- Root TypeScript uses NodeNext modules, ES2022, strict mode, and no emit.
- No inline imports (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Publishable libraries emit through their own build configuration.
- Biome requires tabs, double quotes, semicolons, a 100-column line width, and recommended lint rules.
- Keep extension packages small.
- Add dependencies only for current package needs.
- Use a Pi core function when Pi already provides the required behavior.
- Upgrade an outdated dependency instead of hiding its type errors by removing or downgrading code.
- Keep every extension independently installable and functional by itself.
- Do not import or depend on another extension package.
- Do not assume another extension's names, schemas, settings, events, installation state, version, or behavior.
- Keep policy in the extension that owns the affected behavior.
- Share code only through Pi's public extension-neutral APIs or reusable non-extension libraries.
- Do not make reusable libraries coordinate specific extensions.
- Consume shared Pi APIs without extension-specific branches.
- Give every active extension a thin `src/index.ts` default-export forwarder.
- Declare exactly `"pi": { "extensions": ["./src/index.ts"] }` in every active extension manifest.
- Keep extension implementation in descriptively named modules.
- Publish reusable libraries as JavaScript with declarations and without `pi.extensions` or `piExtension`.
- Run `npm run check:boundaries` to verify package boundaries.
- List every stable extension entrypoint in the root `package.json` under `pi.extensions`.
- Do not list experimental extension entrypoints in the root `package.json` under `pi.extensions`.
- Add root workspace scripts or recipes when users need them.
- Use `@narumitw/pi-tui-kit` for new standard action, detail, settings, and multi-select menus.
- Keep domain state, persistence, confirmations, and specialized UI inside the owning extension.
- Preserve each README's emoji title, npm badge, Pi badge, license badge, standard emoji sections, and `## 🗂️ Package layout`.
- Keep standalone experimental extensions under `packages/` with `"piExtension": { "lifecycle": "experimental" }`.
- Show a user-facing warning for experimental extensions and features.
- Keep experimental packages in root checks and publishing unless they are private.
- Gate an experimental feature inside a stable package with explicit configuration and compatible default behavior.
- Split source files over 1,000 lines by clear responsibilities or document why they must stay intact.
- Do not mechanically split generated, vendored, migration, snapshot, or mainly declarative files.

## Extension change gates

- Read `docs/extension-conventions.md` completely before planning or editing any extension.
- This gate covers package metadata, lifecycle, commands, menus, custom TUI, settings, status, documentation, and verification behavior.
- Also read `docs/extension-settings.md` completely before changing extension-owned settings.
- This settings gate covers loading, persistence, validation, precedence, migration, commands, and UI.
- Before implementation, map every touched area to its applicable **MUST** rules and verification methods.
- Audit user cancellation, component disposal, session replacement, and shutdown for every asynchronous UI or lifecycle flow.
- Cancel or release every task owned by the flow.
- Revalidate stale sessions, generations, contexts, and mutable state after each `await`.
- Treat settings reads and writes as one concurrency protocol.
- Audit settings ordering, failure recovery, stale reads, invalid-file protection, unknown-field preservation, and atomic publication together.
- Audit the final diff against the guides' touched-area and verification checklists.
- Do not use a passing `npm run check` as a substitute for the semantic audit.
- When review finds one convention failure, inspect the whole pull-request diff for the same failure class.
- Name the guides, audits, checks, smokes, deviations, and unverified paths in the handoff.

## Runtime and lifecycle constraints

- Do not call Pi action methods such as `getThinkingLevel()` during extension factory load; defer them until `session_start` or later.
- Treat `agent_end` as a run boundary and `agent_settled` as the idle boundary for retries, final cleanup, and next-item activation.
- Treat `pi.appendEntry()` as branch persistence only; inject compaction-sensitive model contracts through one canonical `context` hook block after the original handoff disappears.
- Key headless session-owned resources by `sessionManager`, not `ctx.ui`, because headless runners can share one no-op UI object.

## TUI and rendering safety

- Treat model IDs, session text, paths, and pasted search text as untrusted terminal input.
- Strip terminal controls at the display boundary without mutating raw payloads, and sanitize before path splitting, filtering, wrapping, or truncation.
- Do not use `wrapTextWithAnsi` for exact code or text previews because it trims whitespace at word-wrap boundaries; use cell-aware hard wrapping or horizontal scrolling.
- Use `Editor.getExpandedText()` when moving a draft outside an editor because `getText()` can retain large-paste markers.
- Initialize a theme and dispose the loader harness in tests that construct `BorderedLoader`.
- Capture evidence inside mocked `ctx.ui.custom()` callbacks and assert after command completion because callback assertions can be caught as menu errors.

## Testing and verification

- Keep active tests under `packages/<package>/test/*.test.ts` and run them with `npm test`.
- Keep archived tests under `deprecated/` and outside active checks.
- Use `npm run check` as the CI-equivalent gate for Biome, boundaries, typechecks, and tests.
- Run `just pack <unscoped-name>` and inspect the tarball after package metadata or publishing changes.
- Run `just try <unscoped-name>` or an equivalent `pi -e` command for Pi runtime behavior when practical.
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
- Use `npm publish --workspace <package> --access public` for the first approved publication of a new scoped package that still returns 404.
- Treat initial publication as a manually approved exception.
- Let `publish.yml` manage the version pull request, package tags, publications, and GitHub releases.
- Publish a new `pi-tui-kit` API before raising a consumer's compatibility floor.
- Do not release an unpublished Kit API together with its first consumer.

## Git and pull requests

- Inspect the selected diff and keep each commit focused on one intent.
- Use `<type>[scope][!]: <description>` based on the actual diff.
- Prefer `feat`, `fix`, `refactor`, or `docs`, and omit unused scope, body, or footers.
- Stage only intended paths, recheck the index, reject empty commits, and report the commit ID and remaining changes.
- Include checks and publish or visibility evidence in pull-request or handoff notes.

## Working preferences

- Prefer `gh --json` for GitHub issue and pull-request links; use web tools only when `gh` cannot expose the required content.
- Keep a predecessor extension active while its successor soaks and deprecate it only after an explicit follow-up decision.
- Create, verify, and archive an executable repository plan for non-trivial implementation work.
- Keep package versions out of long-lived guidance and derive them from manifests, lockfiles, or workflows.
- Keep `just` recipes straightforward, require a clean worktree for dependency maintenance, and prefer Git-based recovery over embedded rollback logic.
- Make `just` install recipes verify registry visibility first and fall back to the local workspace only when that fixes the current install path.
