## Goal

Add a standalone, independently installable `@narumitw/pi-goals` Pi extension that implements ordered goal-array execution through `/goals`, while leaving `extensions/pi-goal` byte-for-byte aligned with `origin/main`.

Success means users can install and run `pi-goals` without installing or modifying `pi-goal`; the two packages use distinct commands, tools, status keys, and session entries; the monorepo checks and package dry run pass.

## Context

The current `feat/goal-array` branch contains a working experimental queue implementation inside `pi-goal`. That implementation is useful as migration input, but the final branch must move the capability into a new package and remove every `pi-goal` change from the diff against `origin/main`.

The new package is the opt-in boundary, so it does not need the current `pi-goal.json` experimental feature flag.

## Architecture

- Package: `extensions/pi-goals`, published as `@narumitw/pi-goals`.
- User command: `/goals`.
- Model tools: `goals_complete` and `goals_blocked`.
- Session entry type: `goals-state` containing the ordered goal array.
- Status key: `goals`.
- Queue operations follow TypeScript array terminology:
  - `/goals push` appends without interrupting the active head.
  - `/goals unshift` schedules an urgent head and, when Pi is busy, activates it only after the current run settles.
  - `/goals pop` removes the tail.
  - `/goals shift` removes the head and activates the next eligible goal.
- Completion records intent during the finishing run and activates the next queued goal only from the settled idle boundary, preventing the old run's later lifecycle events from mutating the next goal.
- The package is self-contained and must not import from or depend on `@narumitw/pi-goal`, matching the repository boundary rule for independently installable extensions.
- Installing both packages is supported at the registration/state level because all public and persisted identifiers differ. Documentation will warn users not to run active `/goal` and `/goals` loops concurrently because both can legitimately inject continuation work.

## Non-Goals

- Do not change `pi-goal` behavior, package metadata, documentation, tests, or published API.
- Do not preserve the `experimental.goals` setting; installing `pi-goals` is the explicit opt-in.
- Do not create a shared runtime package or extension-to-extension dependency in this change.
- Do not publish to npm as part of implementation; only verify the publish payload.

## Assumptions

- The agreed package/command naming is `@narumitw/pi-goals` and `/goals`.
- Existing goal-array semantics on `feat/goal-array` are the behavioral baseline, including independent budgets/accounting, stopped-state preservation, reload migration, and settled-boundary queue advancement.
- The current retained stash and remote branch provide recovery points until the migration is verified.

## Plan

- [x] Preserve a recovery reference to the current goal-array implementation, then restore every path under `extensions/pi-goal` to `origin/main`; verified by recovery branch `backup/feat-goal-array-pi-goal-20260711` and passing `git diff --exit-code origin/main -- extensions/pi-goal`.
- [x] Create `extensions/pi-goals/package.json`, `tsconfig.json`, `LICENSE`, and `README.md` as an independent Pi package at version `0.13.0`, with `pi.extensions` pointing to its real TypeScript entrypoint and publish `files` limited to source/docs/license; verified by metadata assertions, `npm install`, and `npm ls --workspace @narumitw/pi-goals --depth=0`.
- [x] Move and adapt the queue implementation into focused `extensions/pi-goals/src/*.ts` modules, renaming all command, tool, status, prompt, persistence, continuation-marker, custom-message, and stale-guard identifiers to the plural package namespace; verified by identifier/import `rg` audits and the 17-package boundary check.
- [x] Remove the experimental settings gate from the standalone extension so `/goals` and its array completions are always available when installed; verified by parser/autocomplete tests and an `rg` audit showing no experimental settings references in runtime source.
- [x] Preserve the queue state machine's lifecycle guarantees: per-goal token/time accounting, fresh ids on activation, stopped-state restoration, stale tool blocking, budget wrap-up bounds, compaction/retry behavior, and activation only after `agent_settled`; verified by 306 root tests, including completed-run/next-goal, busy-unshift, and stopped-goal accounting regressions.
- [x] Add a package runtime smoke test that loads only `extensions/pi-goals`, exercises `/goals`, validates `goals_complete`/`goals_blocked`, and proves no `/goal` command or singular goal tool is registered; verified by `npm run test:runtime --workspace @narumitw/pi-goals` and root tests.
- [x] Document standalone installation, `/goals` queue semantics, persistence, token budgets, completion/blocking contracts, coexistence naming, and the concurrent-loop warning in `extensions/pi-goals/README.md`; verified by documented/source identifier `rg` comparisons.
- [x] Integrate the package into root discoverability and workflows by updating the root README package table/examples, root `pack:goals` script, `just` pack/try/install/publish aliases, `package-lock.json`, and the default statusline icon; verified by `just --list`, workspace typechecking, statusline tests, and `just pack-goals`.
- [x] Audit the final branch diff so `pi-goal` matches `origin/main`, `pi-goals` is self-contained, no conflict markers or obsolete experimental-setting references remain, and only intended root/statusline integration and memory files changed; verified by `git diff --check`, the zero `pi-goal` diff, and identifier/conflict-marker `rg` checks.
- [x] Run `npm run format`, `npm run check`, the `pi-goals` runtime smoke test, and `just pack-goals`; all passed, and the dry-run tarball contained eight intended files: package metadata, README, LICENSE, and five source modules.
- [x] Replace the current remote feature branch with the clean standalone-package history only after all checks pass, using `git push --force-with-lease` if history was rebuilt; verified local and remote at `a3dbf8c`, retained the original stash/recovery branch, and updated PR #173.

## Risks

- The queue implementation currently inherits a large, subtle lifecycle state machine from `pi-goal`; moving it without equivalent regression coverage could reintroduce continuation, retry, stale-context, or budget bugs. Mitigation: port behavior-focused tests before simplifying implementation details.
- Both extensions can be installed safely but can compete if users activate both loops in one session. Mitigation: unique identifiers plus an explicit README warning; cross-extension arbitration is out of scope.
- Rebuilding the already-pushed feature branch can overwrite remote history. Mitigation: preserve a recovery ref and use only `--force-with-lease` after verification.
- Copying mature goal behavior creates maintenance duplication. This is accepted for package independence in the current change; a shared publishable library can be evaluated separately if both packages evolve together.

## Rollback / Recovery

- Keep `stash@{0}` and a local recovery reference to the pre-migration branch until the standalone package passes all checks and the remote branch is verified.
- If migration fails, reset `feat/goal-array` to the saved recovery reference or reapply the retained stash; `origin/main` and `extensions/pi-goal` remain untouched.
- If a force-with-lease push is rejected, fetch and inspect the remote update instead of overriding it.

## Completion Checklist

- [x] `pi-goal` is unchanged from `origin/main`, verified by passing `git diff --exit-code origin/main -- extensions/pi-goal`.
- [x] `@narumitw/pi-goals` is independently installable and exposes only plural identifiers, verified by metadata assertions, registration tests, identifier audits, and runtime smoke registration assertions.
- [x] Goal-array ordering and lifecycle behavior is verified by 306 passing tests covering `push`, settled `unshift`, `pop`, `shift`, completion advance, stopped states, accounting, reload, retry/compaction, budgets, and stale ids.
- [x] Package boundaries and repository quality gates pass, verified by `npm run check`.
- [x] Publish contents are correct, verified by `just pack-goals` reporting only package metadata, README, LICENSE, and five source files.
- [x] Root documentation, statusline default, and workflow aliases include `pi-goals`, verified by README review, statusline tests, and `just --list`/root script inspection.
- [x] The final branch is synchronized with its remote and contains no unintended `pi-goal` delta, verified by matching local/remote commit `a3dbf8c`, passing the targeted diff command, and PR #173.
