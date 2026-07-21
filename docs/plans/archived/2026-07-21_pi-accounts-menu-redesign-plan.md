# Pi Accounts menu redesign plan

## Goal

Redesign `@narumitw/pi-accounts` from a multi-argument slash-command surface into a single interactive `/accounts` account manager, then open a PR with tests and documentation proving the new workflow.

## Context

The current extension exposes `/account list/login/switch/remove` plus temporary Codex aliases. The agreed design is a Pi-style interactive manager: `/accounts` is the only command, ignores arguments, requires interactive UI, shows all supported providers' active account summary, and routes login/switch/remove through selectors.

## Non-Goals

- Do not add API-key profile management or arbitrary custom provider support.
- Do not introduce a custom TUI component; use `ctx.ui.select`, `ctx.ui.input`, `ctx.ui.confirm`, and notifications.
- Do not change credential storage schema or OAuth provider adapters beyond what the new UI requires.

## Plan

- [x] Add failing tests for the new command surface, menu routing, empty state, non-interactive rejection, argument ignoring, and removed `/account`/Codex aliases; verified by the initial `npm test` red run timing out after reaching the new tests while `/accounts` was not implemented.
- [x] Add failing tests for interactive login, duplicate-name replacement confirmation, reserved `default`, current-provider switch, other-provider switch, remove confirmation, active-account removal fallback, and unknown-model default selection; verified by the same red `npm test` run before implementation and by the final green test suite.
- [x] Implement `/accounts` as the only registered account command and wire the interactive menu to existing OAuth/storage/runtime operations; verified by `npm test` passing 955 tests after implementation.
- [x] Update README usage and feature text to document the single-command interactive workflow and removed aliases; verified by source inspection showing `pi.registerCommand("accounts", ...)` and no registered `/account` or Codex alias commands in `extensions/pi-accounts/src/accounts.ts`.
- [x] Run formatting/type/test gates for the affected package and root checks that are practical for the change; verified by `npm --workspace @narumitw/pi-accounts run check`, `npm test`, `npm run check`, and `npm run pack:accounts`.
- [x] Commit the intended changes on a feature branch, push it, and create a GitHub PR; verified by commit `04fbbfe`, branch `redesign-pi-accounts-menu`, push to `origin/redesign-pi-accounts-menu`, and PR #306.

## Risks

- The selector API only supports plain string choices, so provider/account grouping must be encoded in labels without relying on hidden values.
- Removing aliases is a breaking command-surface change; README and tests must make the new single entry point explicit.
- Login and switch affect runtime auth; tests should assert observable notifications, active storage, and model-selection side effects without real network calls.

## Completion Checklist

- [x] The saved implementation plan exists and reflects completed task evidence in `docs/plans/archived/2026-07-21_pi-accounts-menu-redesign-plan.md`.
- [x] `/accounts` is the only registered account-management command, verified by `accounts registers only the interactive /accounts command and lifecycle hooks` and source inspection of `extensions/pi-accounts/src/accounts.ts`.
- [x] Interactive menu behavior matches the agreed design, verified by tests covering empty, current-provider, other-provider, login, remove, duplicate replacement cancellation/confirmation, active removal fallback, unknown-model onboarding, and non-interactive states.
- [x] README documents the new `/accounts` workflow and no longer documents removed command entry points, verified by text search for removed command names.
- [x] Verification commands pass for the changed package/repository scope, with command output recorded in this plan: `npm --workspace @narumitw/pi-accounts run check`, `npm test`, `npm run check`, and `npm run pack:accounts`.
- [x] A PR exists for the branch and contains the committed implementation, verified by PR #306 and `gh pr view`.
