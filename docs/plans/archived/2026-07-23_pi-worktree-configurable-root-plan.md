## Goal

Make `@narumitw/pi-worktree` suggest new worktrees under a configurable machine-local root, defaulting to `~/.worktrees`, while preserving the existing single interactive `/worktree` command and all Add, Switch, Remove, and Prune safety behavior.

## Context

- The current suggestion is a sibling of the registered main worktree, such as `/workspace/project-feat-login`.
- The new default is `~/.worktrees/<main-worktree-name>/<normalized-branch>`, resolved with Node's `homedir()` on Linux, macOS, and Windows.
- Repository guidance prefers one interactive manager command. `/worktree` must continue rejecting arguments; no subcommands, hidden argument fallbacks, or argument autocomplete will be added.
- Production removal already uses argv-only `git worktree remove`; test-only `rmSync` fixture cleanup is not shipped runtime behavior.

## Architecture

- Add `src/settings.ts` to own `<getAgentDir()>/pi-worktree.json`, runtime validation, home expansion, effective-source tracking, last-known-good reload behavior, and unknown-field-preserving atomic saves.
- Recognize only an optional string `worktreeRoot`. Missing settings use `join(homedir(), ".worktrees")`. Accept `~`, home-prefixed `~/...` (and the native Windows separator), or an absolute native-platform path. Reject empty, relative, NUL-containing, shell-variable-like, non-string, or unnormalizable values without overwriting the file.
- Keep settings machine-local: no project override, environment override, migration, or dependency.
- Inject a settings provider into command registration. Load on `session_start`, preserve the last valid runtime root after later load failures, warn through the fresh context, and apply a successful interactive save immediately.
- Keep `/worktree` argument-free. Add `Configure worktree root` to its existing interactive menu, show the effective root/source in the menu title, use one input prompt, treat blank input as reset to `~/.worktrees`, and refuse to overwrite a currently malformed/invalid settings file.
- Derive suggestions as `<effective-root>/<basename(registered-main-worktree)>/<branch-with-slashes-replaced-by-hyphens>`. Existing single-operation custom target input, collision checks, symlink-ancestor checks, Git identity verification, and fail-closed behavior remain unchanged.
- Existing worktrees are never moved. Remove and Prune retain their current guards and invoke only Git argv; production code must not invoke a shell, `rm`, or filesystem directory deletion for worktrees.

## Plan

- [x] Added red-first path/settings tests under `extensions/pi-worktree/test/` for the `~/.worktrees` default, project/branch composition, custom roots, POSIX and Windows absolute paths, home expansion, rejected values, source reporting, and normalization collisions; `npm test` failed as intended because `settings.ts` and the root-aware path signature did not yet exist.
- [x] Implemented `extensions/pi-worktree/src/settings.ts` with lazy path resolution through `getAgentDir()`, validation, missing/loaded/invalid results, serialized last-known-good runtime state, unknown-field-preserving atomic save/reset, and injectable file operations; root `npm test` passes missing, valid, malformed, invalid, reload-failure, ordering, unknown-field, and publish-failure tests.
- [x] Updated path derivation and Add flow in `src/git.ts` and `src/command.ts` to use the effective root and registered main basename while preserving per-operation target overrides and all pre/post Git checks; root `npm test` passes focused Git and Add command coverage.
- [x] Extended only the no-argument interactive menu with `Configure worktree root`, effective root/source display, cancel/reset/save/rollback behavior, and invalid-file protection; focused command tests prove arguments remain rejected, autocomplete remains absent, and non-UI invocation stays mutation-free.
- [x] Updated `src/worktree.ts` to reload settings on `session_start` and inject the runtime provider without reading session state during factory load; tests pass for reload, immediate application, replacement-context warning, and last-known-good behavior.
- [x] Updated `extensions/pi-worktree/README.md` with the new default layout, cross-platform home semantics, JSON file and accepted values, interactive configuration/reset flow, reload/error behavior, no migration of existing worktrees, collision behavior, and Git-only Remove/Prune boundary; package check and source review confirm the documented command/defaults match.
- [x] Formatted intended files and ran focused coverage through root `npm test`, package check/typecheck, full `npm run check`, and `just pack-worktree`; all 1,129 tests pass, the tarball contains the expected eight package files including `src/settings.ts`, and the source audit finds only argv-based Git process calls plus temporary-settings-file cleanup.
- [x] Audited the final diff against this plan, marked every completion check with evidence, and confirmed the destination is available before archiving this completed plan under `docs/plans/archived/`.

## Risks

- A global custom root can collide for same-named main worktrees. The implementation intentionally adds no hash or suffix; an existing/registered target remains a hard stop and the user can change the root or one-operation target.
- A settings file can become invalid after a valid load. The runtime must retain the last-known root but refuse interactive overwrite until the file is fixed, so malformed user content is never destroyed.
- Git can create a branch before a target-path setup error. Existing ancestor checks and post-add verification remain mandatory; successful Git creation is never rolled back solely because later Pi switching fails.

## Non-Goals

- No subcommands, autocomplete, project-scoped settings, environment variables, path templates, hashes, suffix allocation, bulk cleanup, automatic expiry, cache cleaner, `/tmp` fallback, or new dependency.
- No movement, re-registration, or deletion of existing worktrees.
- No changes to branch semantics, Pi session switching, removal confirmation, administrative-history checks, or prune policy.

## Completion Checklist

- [x] Missing settings and reset suggest `~/.worktrees/<main-name>/<branch-slug>` on the active platform; command tests prove a valid user override changes the next Add suggestion immediately.
- [x] Invalid settings fail closed without overwrite; load/save failure tests retain the last valid runtime root and original file, and unknown fields survive save/reset.
- [x] `/worktree` remains a single argument-free interactive command whose original four operations are unchanged and whose fifth action configures or resets the root; autocomplete remains absent.
- [x] All existing Add, Switch, Remove, ignored-data, administrative-history, Prune, and session-switch regressions pass in the 1,129-test repository suite.
- [x] README, the eight-file package dry run, and the runtime source audit match the implemented settings and Git-only mutation boundaries.
- [x] Focused tests, package checks, full `npm run check`, `just pack-worktree`, and final diff checks pass with no known required work remaining.
