## Goal

Add the independently installable `@narumitw/pi-worktree` production extension with one interactive `/worktree` command for safe `list`, `add`, session-backed `switch`, clean `remove`, and preview-first `prune` operations.

## Architecture

- Parse `git worktree list --porcelain -z` into package-owned records and execute Git only through argv-based `pi.exec("git", args, { cwd })` calls.
- Keep Git parsing/validation, Pi session switching, and interactive command orchestration in separate modules.
- Implement “cd” by forking or creating a Pi session whose header cwd is the target worktree, then calling public `ctx.switchSession()`.
- Fail closed for force removal, local-only data, locks, unreachable detached commits, stale/bare metadata, and unsupported non-UI use.

## Non-Goals

- No `move`, `repair`, `lock`, `unlock`, `--force`, detached/orphan add, branch deletion, custom prune expiry, settings, watcher, statusline, or LLM tool.

## Plan

- [x] Add red-first domain tests for NUL porcelain parsing, worktree states, path derivation, branch occupancy, and safe argv; implemented the Git service and verified it with `npm test` (981 tests passed), including two disposable-repository Git integration tests.
- [x] Add red-first command tests and implement the interactive `/worktree` menu plus list/add flows, including cancellation, validation, verification, and optional switch; `npm test` covers new/occupied branches, safe argv, cancellation, listing, and command-driven switching.
- [x] Add red-first session tests and implement persisted-session fork switching, active-branch copying for ephemeral sessions, an official v3 empty-header fallback, and replacement-context-only success handling; verified persisted/ephemeral/empty/cancelled/failed/stale-context cases with public `SessionManager` APIs.
- [x] Add red-first remove/prune tests and implement main/current/dirty/ignored/initialized-submodule/locked/detached reachability guards plus preview/cancel/confirm behavior; disposable-repository regressions cover ignored/untracked data, detached commits, porcelain-hidden prune metadata, staged-only indexes, and reflog/per-worktree-ref/`FETCH_HEAD`-only commits.
- [x] Add the production package metadata, README, license, tsconfig, and cohesive source layout under `extensions/pi-worktree/`; the package check and typecheck pass and every source file is below 1,000 lines.
- [x] Integrate the package into root scripts, just aliases, README, and lockfile; the lockfile was generated with npm 11.16.0 using the repository-compatible legacy peer resolution and `just --list` exposes all four aliases.
- [x] Run formatting, `npm test`, `npm run typecheck`, the full `npm run check`, `just pack-worktree`, disposable-repository Git regressions, non-interactive Pi extension loading, and final diff checks; all 1,036 repository tests pass and the dry-run tarball contains only the seven intended package files.

## Risks

- Pi has no mutable cwd API; session replacement must be used and old contexts become stale immediately after success.
- Git worktree removal and pruning can destroy ignored files or unreachable detached commits; the MVP refuses any uncertain case instead of using force.
- A Git add can succeed before Pi session switching fails; retain the valid worktree and report a retry path rather than rolling it back.

## Completion Checklist

- [x] `/worktree` exposes only the five agreed interactive actions and every mutation requires the planned validation/confirmation.
- [x] Add and switch preserve safe Git semantics and continue the current Pi conversation in a target-cwd session.
- [x] Remove and prune cannot discard detected local-only data, staged administrative indexes, or unreachable commits preserved by worktree administrative history.
- [x] Package metadata, repository integration, user documentation, and npm dry-run contents are complete.
- [x] The full repository gate, disposable Git regressions, and non-interactive Pi load smoke pass with no known required work remaining.
