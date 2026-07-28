# pi-goal pi-tui-kit migration plan

## Goal

Migrate pi-goal's standard goal manager, ordered-queue manager, settings screen, safety-limit
choices, status, and help navigation to `@narumitw/pi-tui-kit` without changing goal ownership,
stale-turn guards, token/time accounting, queue ordering, safety enforcement, persistence rollback,
direct command routes, or the current non-TUI status behavior.

## Context

`extensions/pi-goal/src/menu.ts` currently runs label-driven `ctx.ui.select()` loops for the main and
queue menus. `extensions/pi-goal/src/settings-ui.ts` owns a custom `SettingsList`, nested
`SelectList` limit choices, invalid-file detail view, free-form limit input, confirmations, ordered
saving, runtime application, and rollback. The standard action/detail/settings layers fit the kit;
objective editors, numeric input, destructive/safety confirmations, goal-state transactions, and
settings persistence remain extension-owned.

The bare `/goal` route opens the manager only in TUI mode. In RPC, print, and JSON modes it preserves
the existing full-status route rather than exposing new goal mutations through the kit's RPC adapter.

## Architecture

- Define stable screens for Main, Queue, Settings, Automatic Work, No-progress Guard, Ordered Queue,
  Status, Help, and invalid-settings guidance. Keep raw goal ids and queue identities separate from
  sanitized labels and lines.
- Refresh usage accounting and derive the latest active/queued/pending state before each screen is
  resolved. Every mutating action revalidates the displayed active goal or queue identity after each
  editor, input, or confirmation await.
- Keep all four settings on one Settings screen. Use immediate kit values only for Goal tool
  visibility; route safety limits and the experimental queue to standard choice screens so custom
  input and confirmation open only after the prior custom screen has closed.
- Continue applying settings through `applyGoalSettings()` and the existing save/rollback protocol.
  The kit owns visual serialization and rejected-value rollback, not file publication, tool
  visibility, queue freezing, abort policy, or resume dispatch.
- Add a session-owned menu controller/generation in the goal extension, rotate it on every
  `session_start`, abort it on `session_shutdown`, and pass its signal and current-generation guard to
  `runMenu()`.
- Close the manager after actions that start, pause, resume, edit, replace, clear, skip, prioritize,
  or otherwise hand control to Goal work. Preserve Back and cursor restoration for read-only and
  settings subflows.

## Non-Goals

- Changing goal prompts, markers, stale-tool protection, completion/blocking tools, budgets, queue
  persistence, settings schema, or experimental feature semantics.
- Replacing objective editors, numeric inputs, exact confirmations, notifications, or Goal-owned
  transactions with generic kit behavior.
- Enabling the mutating manager in RPC, print, or JSON modes or removing established `/goal`
  arguments and completions.

## Risks

- A goal or queue can change while an editor or confirmation is open. Stable screen ids are not a
  substitute for the existing goal/queue identity rechecks.
- Lowering a safety limit or freezing a queue can abort Goal-owned work. A generic transition must
  occur only after `applyGoalSettings()` and any queue-resume callback reach their existing commit or
  rollback boundary.
- Repeated state loads can double-charge elapsed/token usage. Preserve the current accounting
  checkpoints and prove idempotent menu refreshes with focused tests.
- A settings confirmation opened from inside a still-active custom screen can regress focus and
  cancellation. Route confirmation-bearing settings through a choice screen first.

## Plan

- [ ] Add the `<1` `@narumitw/pi-tui-kit` runtime dependency and lockfile edge to `pi-goal`; verify
      `npm run check:boundaries` and `npm run pack:goal` show one independently installable runtime
      dependency with no extension-to-extension edge.
- [ ] Add failing screen-model and runtime tests for empty, active, paused, blocked, usage-limited,
      budget-limited, completed, pending-action, and frozen-queue states; cover stable ids, Main/Queue
      Back behavior, cursor restoration, TUI cancellation, session abort, RPC/print/JSON status-only
      behavior, and terminal-safe goal text.
- [ ] Replace the Main and Queue selector loops with typed action screens and a session-owned menu
      signal, delegating start/edit/budget input and exact destructive confirmations to the existing
      command controller; verify goal/queue replacement races still reject every stale mutation.
- [ ] Extract reusable Status and Help lines and expose them as kit detail screens from the manager
      while retaining the documented direct status/help routes and mode-appropriate notifications;
      verify no manager action becomes available outside TUI.
- [ ] Replace the custom settings shell and limit selectors with one Settings screen plus Automatic
      Work, No-progress Guard, Ordered Queue, and invalid-file screens; preserve the four-item order,
      positive-integer validation, active-goal snapshots, post-screen confirmations, queue-unfreeze
      dispatch, immediate Goal-tools application, ordered saves, and rollback after persistence or
      runtime failures.
- [ ] Remove only superseded `SelectList`/`SettingsList` wrappers after focused menu and settings tests
      prove narrow-width rendering, exact maximum-safe-integer display, theme invalidation,
      cancellation/disposal, and pending-save draining through the kit contract.
- [ ] Update `extensions/pi-goal/README.md` for standard navigation and unchanged mode behavior, then
      run the package typecheck, root tests, `npm run check`, `npm run pack:goal`, and
      `npm run test:runtime --workspace @narumitw/pi-goal`; inspect the tarball and declared entrypoint.
- [ ] Audit the final diff against command, TUI, asynchronous lifecycle, settings, persistence,
      status, package, and verification conventions; record any accepted behavior deviation before
      archiving the plan.

## Completion Checklist

- [ ] Main, Queue, Settings, limit choices, Status, Help, and invalid-settings guidance use
      `pi-tui-kit`; editors, inputs, confirmations, and Goal transactions remain extension-owned.
- [ ] Goal ids, queue identity, usage accounting, safety guards, tool visibility, persistence,
      rollback, and resume behavior are unchanged.
- [ ] TUI cancellation/disposal/replacement and RPC/print/JSON status-only behavior are explicit and
      tested.
- [ ] Focused tests, runtime smoke, package/root checks, entrypoint load, and pack inspection pass.
