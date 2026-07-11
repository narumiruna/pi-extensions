# Repository Guidelines

## Project structure

- This is a Node/TypeScript monorepo for independently installable Pi extension packages plus explicitly local-only experiments.
- Production extension code lives under `extensions/<package>/src/*.ts`; experimental code lives under `extensions/experimental/<package>/src/*.ts`; each package has its own `package.json`, `README.md`, `LICENSE`, and `tsconfig.json`.
- Root config owns shared tooling: `package.json`, `package-lock.json`, `biome.json`, `tsconfig.json`, `justfile`, and `.github/workflows/*`.
- Do not hand-edit generated dependency output such as `node_modules/`. Keep package contents aligned with each package `files` list and `pi.extensions` entry.

## Commands

Run commands from the repository root unless noted otherwise.

- Install dependencies: `npm install`
- Full verification: `npm run check` or `just check`
- Run extension tests: `npm test`
- Format with Biome: `npm run format` or `just format`
- Typecheck all workspaces: `npm run typecheck`
- Preview npm package contents: `just pack-caffeinate`, `just pack-chrome-devtools`, `just pack-firecrawl`, `just pack-goal`, `just pack-lsp`, `just pack-retry`, `just pack-statusline`, or `just pack-sync`
- Try a local extension without installing: `just try-caffeinate`, `just try-chrome-devtools`, `just try-firecrawl`, `just try-goal`, `just try-goals`, `just try-lsp`, `just try-retry`, `just try-statusline`, or `just try-sync`
- Inspect available recipes before adding new workflow commands: `just --list`

## Code style

- TypeScript uses `module`/`moduleResolution: NodeNext`, `target: ES2022`, `strict: true`, and `noEmit: true`.
- Biome is authoritative: tabs, 100-column line width, double quotes, semicolons, and recommended lint rules.
- Keep extension packages small and self-contained. Add dependencies only when they solve a current extension need.
- Name an active extension-managed user JSON file `<unscoped-package-name>.json`; use the same basename for project overrides. Credential sensitivity changes permissions and migration handling, not the basename. Use variants such as `.local` or state filenames only when they communicate a concrete storage semantic.
- Production extensions include source in `pi.extensions`, publish `files`, and root workspace-aware scripts/recipes when users need them.
- Experimental extensions must live under `extensions/experimental/`, show a user-facing experimental warning, remain covered by root checks, and stay excluded from automated publish/version workflows.
- When a source file exceeds 1,000 lines, it must be reviewed for decomposition. Split it along clear responsibility boundaries when doing so improves cohesion, maintainability, or testability. Do not split files mechanically solely to satisfy the line limit. Generated, vendored, migration, snapshot, and primarily declarative files may be exempt.

## Testing and verification

- Extension tests live under `extensions/<package>/test/*.test.ts` or `extensions/experimental/<package>/test/*.test.ts` and run with `npm test`.
- Use `npm run check` as the CI-equivalent local gate; it runs Biome, boundary checks, workspace typechecks, and tests.
- For package metadata or publishing changes, also run the relevant `just pack-*` dry run and inspect the tarball contents.
- For Pi runtime behavior, prefer `pi -e ./extensions/<package>` or the matching `just try-*` recipe before publishing.

## Publishing and release safety

- Publish recipes accept an optional OTP, e.g. `just publish-goal 123456`; never commit OTPs, tokens, or npm credentials.
- Experimental packages may be published only by an explicit maintainer using `just publish <name>`; never add them to `publish-all` or GitHub publish workflows.
- If npm shows a scoped package dist-tag but `npm view <package>` returns 404, use `just npm-public <package> <otp>` to set public visibility before bumping or republishing.
- Use `just bump <package> patch|minor|major` for a no-tag workspace bump. The GitHub `bump-version` workflow bumps all package versions together and tags `v*.*.*`.

## Git and PR guidance

- Recent history uses Conventional Commits such as `feat: ...`, `fix: ...`, and `chore(release): ...`; keep commit messages grounded in the actual diff.
- Stage only intended paths. Do not use blanket staging for unrelated local changes.
- For PRs or handoff notes, include the commands run and any publish/visibility checks performed.

## MEMORY.md

- `MEMORY.md` is not auto-loaded. Check it before non-trivial debugging or design work when prior project context may matter.
- Keep entries short and reusable.
- `MEMORY.md` must use `## GOTCHA` and `## TASTE` sections.
- After a non-trivial error or discovery, add one concise entry if it will help future work.
