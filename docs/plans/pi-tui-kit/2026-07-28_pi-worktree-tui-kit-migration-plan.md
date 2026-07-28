# pi-worktree pi-tui-kit migration plan

## Goal

Migrate `/worktree`'s current-state action menu to `@narumitw/pi-tui-kit` while preserving every Git
preflight/revalidation, destructive preview, settings write, branch/data safety boundary, and Pi
session-replacement behavior. Keep operation-specific worktree selectors and input/confirm dialogs
extension-owned as one-off domain prompts.

## Context

`extensions/pi-worktree/src/command.ts` has one standard five-action selector followed by specialized
Add, Switch, Remove, Prune, and Configure root flows. The command waits for idle and snapshots
worktree/root state before opening. Successful switching tears down the captured session, so a menu
continuation must become stale without touching the old context. `worktree.ts` tracks only a numeric
settings generation today.

## Architecture

Use one dynamic action screen with summary lines for count, current path, effective root/source, and
settings warning. Each action invokes the existing specialized flow and closes. Add a session-owned
menu controller/generation in the extension runtime and pass it into command registration; session
replacement/shutdown aborts `runMenu()` before it can reopen or notify through the old context.

Keep `selectWorktree()` as a one-off domain selector because its choice immediately enters a distinct
review/mutation flow and its rows contain operation-specific safety state. Keep all inputs,
confirmations, exact inventories/OIDs, Git execution, and `ctx.switchSession()` handoff unchanged.
No-UI modes must reject observably; `/worktree` continues to reject arguments.

## Non-Goals

- Converting Git workflows, confirmations, inputs, or worktree list formatting into shared screens.
- Adding subcommands, flags, force operations, branch deletion, or new worktree capabilities.
- Changing settings path/schema or Pi session-copy behavior.

## Risks

- `ctx.switchSession()` invalidates the old command context after its await. The menu owner signal must
  abort during old-session shutdown and the action must not publish through the captured context.
- Menu state can become stale before Add/Remove/Prune; existing operation-level revalidation remains
  authoritative and must not be removed as duplicate work.

## Plan

- [ ] Add the `<1` kit dependency and lockfile edge; verify package boundaries and independent install.
- [ ] Add failing tests for summary/action screens, argument/no-UI rejection, settings warnings,
      action routing, owner cancellation, and successful Switch causing a stale menu result without
      old-context notification.
- [ ] Add a session-owned menu controller to `worktree.ts`, pass ownership into the command module,
      and replace only the top-level selector with `runMenu()`; verify focused command/lifecycle tests.
- [ ] Retain specialized worktree selectors and all operation preflights, then run existing Add,
      Switch, Remove, ignored-data, administrative-history, Prune, settings, and session tests to prove
      no safety path was weakened.
- [ ] Update README only for standard menu key/mode behavior, then run package/root checks, root tests,
      `npm run pack:worktree`, and an isolated non-mutating Pi/Git menu smoke in a temporary repository.
- [ ] Audit command, session replacement, Git safety, settings, package, and verification conventions
      before archiving.

## Completion Checklist

- [ ] Only the standard root action menu migrated; specialized Git prompts remain extension-owned.
- [ ] Session switching cannot resume or notify through a stale menu context.
- [ ] All Git, settings, branch/data, and direct command safety behavior is unchanged.
- [ ] Tests, checks, temporary-repository smoke, and pack inspection pass.
