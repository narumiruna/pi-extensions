## Goal

Move `pi-goals` to `extensions/experimental/pi-goals` as a repository-local experimental extension that remains fully tested and runnable from a local checkout, but is not exposed as an installable package.

## Context

`pi-goals` currently lives beside production packages at `extensions/pi-goals`, is listed in public package documentation, and has root pack/install/publish workflows. The experiment should retain its current `/goals` behavior and test coverage while being clearly separated from publishable extensions.

## Architecture

- Use `extensions/experimental/pi-goals` as the canonical location.
- Keep `@narumitw/pi-goals` as the local workspace identity so existing imports and test harnesses do not need a behavioral rename.
- Mark the package `private: true` and keep it in npm workspaces through `extensions/experimental/*` so root typechecking and dependency installation still work.
- Include experimental workspaces in formatting, boundary checks, unit tests, and runtime smoke tests, but exclude them from generic `try-all`, pack/install/publish, version-bump, and release flows.
- Do not add a root `pi` manifest: this monorepo contains many extensions and must not masquerade as a single installable Pi package.
- Keep the current plural command/tool/status/session identifiers unchanged.

## Non-Goals

- Do not publish `@narumitw/pi-goals` or add npm/Git repository installation paths.
- Do not change queue semantics, lifecycle behavior, persistence format, or tool contracts.
- Do not move or modify `extensions/pi-goal`.
- Do not integrate `pi-goals` with or modify `extensions/pi-statusline`.
- Do not load experimental extensions from `just try-all` by default.

## Assumptions

- The experimental directory name is `extensions/experimental`.
- Use requires a local repository checkout followed by `pi -e ./extensions/experimental/pi-goals` or the dedicated `just try-goals` alias.
- PR #173 remains the delivery PR and should describe `pi-goals` as experimental, local-checkout-only, and unpublished while retaining its relationship to #157.

## Plan

- [x] Move the complete package from `extensions/pi-goals` to `extensions/experimental/pi-goals`, update its nested `tsconfig.json` root reference and repository directory, set `private: true`, and use version `0.0.0`; verified by staged rename evidence, metadata assertions, and `npm ls --workspace @narumitw/pi-goals --depth=0`.
- [x] Add `extensions/experimental/*` to root npm workspaces and regenerate `package-lock.json` so the private package remains dependency-managed without adding a root `pi` manifest; verified by root metadata assertions, `npm install --package-lock-only --ignore-scripts`, `npm install --ignore-scripts`, and lockfile workspace-path inspection.
- [x] Update `tsconfig.test.json`, `scripts/run-tests.mjs`, and `scripts/check-extension-boundaries.mjs` to discover both production and experimental packages while still excluding `extensions/deprecated`; verified by 307 passing tests (including `pi-goals`) and the boundary report for 17 active packages with 1 experimental.
- [x] Remove `pack:goals` and the `just` pack/install/publish aliases for `pi-goals`, preserve only a dedicated local `try-goals` path targeting `extensions/experimental/pi-goals`, and keep `try-all` production-only; verified by `just --list`, root script inspection, and no-match `rg` audits.
- [x] Keep release automation from touching the experiment by making shared-version discovery skip private workspace packages and confirming publish workflows only enumerate non-private production package paths; verified by the new fixture test, `--list-packages` output, and workflow/source inspection.
- [x] Rewrite the root README and `extensions/experimental/pi-goals/README.md` to label `pi-goals` experimental and local-checkout-only, remove npm/Git install badges and pack/publish instructions, document `pi -e ./extensions/experimental/pi-goals`, and update the repository tree/conventions; verified by targeted `rg` and file existence checks.
- [x] Update repository guidance so future changes distinguish production, experimental, and deprecated extension locations and require `private: true` for experiments; verified against the implemented workspace and CI behavior.
- [x] Run the unchanged `pi-goals` unit and real-runtime coverage from the nested location, including plural-only registration and busy-unshift lifecycle scenarios; verified by 307 root tests, the passing workspace runtime smoke test, and an offline explicit local-path Pi load.
- [x] Audit that `pi-goals` has no publish route, remains self-contained, and both `extensions/pi-goal` and `extensions/pi-statusline` match `origin/main`; verified by `git diff --check`, metadata assertions, targeted `rg` audits, and passing targeted diff commands.
- [x] Run `npm run format` and `npm run check`, then update PR #173 to describe the experimental local-checkout-only placement and mention #157 without claiming an installable release; verified by passing local gates, implementation commit `88c78ff`, and the remote PR body.

## Risks

- Nested packages can silently fall out of test or boundary discovery. Mitigation: explicitly extend workspace, test-compile, test-runner, and boundary-discovery paths and assert that `pi-goals` tests execute.
- A private workspace can still be accidentally included in version tooling. Mitigation: combine `private: true`, nested-directory exclusion from release enumeration, removal of publish aliases, and private-workspace filtering in version scripts.
- Public README language can imply remote availability or production readiness even when publishing is disabled. Mitigation: move references into a clearly labeled experimental section and document only explicit local-checkout use.
- Generic local loading could activate unstable behavior unintentionally. Mitigation: keep `try-all` production-only and require an explicit `try-goals` or `pi -e` command.

## Rollback / Recovery

- The move is path-only for extension behavior; rollback by restoring `extensions/pi-goals`, the previous workspace patterns, and the prior root workflow/docs references.
- Preserve the current commits and remote branch history so the publishable-layout version remains recoverable until the experimental relocation is verified.

## Completion Checklist

- [x] `pi-goals` exists only at `extensions/experimental/pi-goals` and is a private `0.0.0` workspace, verified by path checks, metadata assertions, and `npm ls`.
- [x] No root command or release workflow can pack, install, publish, or version-bump `pi-goals`, verified by `just --list`, package scripts, workflow inspection, the version-discovery fixture, and targeted `rg` checks.
- [x] Root quality gates still include the experimental extension, verified by the 17-package boundary check, experimental workspace typecheck, and 307 passing tests.
- [x] Local experimental runtime use works, verified by the package runtime smoke test, offline nested `pi -e` path load, and `just try-goals` recipe inspection.
- [x] Documentation consistently labels `pi-goals` experimental and local-checkout-only, verified by README review and absence of npm/Git install or publish commands for the package.
- [x] `extensions/pi-goal` and `extensions/pi-statusline` remain unchanged from `origin/main`, verified by passing targeted `git diff --exit-code` commands.
- [x] PR #173 points to the final branch, mentions #157, documents local-checkout-only use, and does not claim that `pi-goals` is remotely installable or publishable, verified through `gh pr view 173`.
