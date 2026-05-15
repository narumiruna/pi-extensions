# Repository Guidelines

## Project structure

- This is a Node/TypeScript monorepo for independently installable Pi extension packages.
- Edit extension code under `extensions/<package>/src/*.ts`; each package has its own `package.json`, `README.md`, `LICENSE`, and `tsconfig.json`.
- Root config owns shared tooling: `package.json`, `package-lock.json`, `biome.json`, `tsconfig.json`, `justfile`, and `.github/workflows/*`.
- Do not hand-edit generated dependency output such as `node_modules/`. Keep package contents aligned with each package `files` list and `pi.extensions` entry.

## Commands

Run commands from the repository root unless noted otherwise.

- Install dependencies: `npm install`
- Full verification: `npm run check` or `just check`
- Format with Biome: `npm run format` or `just format`
- Typecheck all workspaces: `npm run typecheck`
- Preview npm package contents: `just pack-chrome-devtools`, `just pack-goal`, or `just pack-retry`
- Try a local extension without installing: `just try-chrome-devtools`, `just try-goal`, or `just try-retry`
- Inspect available recipes before adding new workflow commands: `just --list`

## Code style

- TypeScript uses `module`/`moduleResolution: NodeNext`, `target: ES2022`, `strict: true`, and `noEmit: true`.
- Biome is authoritative: tabs, 100-column line width, double quotes, semicolons, and recommended lint rules.
- Keep extension packages small and self-contained. Add dependencies only when they solve a current extension need.
- When adding an extension, include the source in `pi.extensions`, package publish `files`, and root workspace-aware scripts/recipes if users need them.

## Testing and verification

- There is no separate test suite configured; use `npm run check` as the CI-equivalent local gate.
- For package metadata or publishing changes, also run the relevant `just pack-*` dry run and inspect the tarball contents.
- For Pi runtime behavior, prefer `pi -e ./extensions/<package>` or the matching `just try-*` recipe before publishing.

## Publishing and release safety

- Publish recipes accept an optional OTP, e.g. `just publish-goal 123456`; never commit OTPs, tokens, or npm credentials.
- If npm shows a scoped package dist-tag but `npm view <package>` returns 404, use `just npm-public <package> <otp>` to set public visibility before bumping or republishing.
- Use `just bump <package> patch|minor|major` for a no-tag workspace bump. The GitHub `bump-version` workflow bumps all package versions together and tags `v*.*.*`.

## Git and PR guidance

- Recent history uses Conventional Commits such as `feat: ...`, `fix: ...`, and `chore(release): ...`; keep commit messages grounded in the actual diff.
- Stage only intended paths. Do not use blanket staging for unrelated local changes.
- For PRs or handoff notes, include the commands run and any publish/visibility checks performed.
