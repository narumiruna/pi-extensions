# Pi TUI Kit Review Fixes

## Goal

Resolve every review thread on PR #446 while preserving the menu library's declarative API and the two pilot extensions' behavior.

## Context

The review identified ten concerns across package metadata, input adaptation, RPC identity, settings and multi-select state, dynamic refresh, disposal draining, session cancellation, and search focus. The dynamic-refresh concern is already covered by the current branch and will be verified rather than changed.

## Plan

- [x] Add focused regressions for remapped bindings, disabled and untrusted setting values, concurrent multi-select rejection, duplicate RPC labels, disposal draining, and owner cancellation; red runs failed on binding forwarding, raw rendering, committed rollback, RPC identity, early return, and missing abort propagation.
- [x] Harden `packages/pi-tui-kit` at shared boundaries: unrestricted Pi peers, direct binding forwarding, raw/display setting separation, committed toggle rollback, unique RPC choices, pending-task draining, and owner `AbortSignal` propagation; remove unsupported settings search until Pi exposes focus forwarding.
- [x] Connect Chrome DevTools and Firecrawl menu runs to session-owned abort signals without changing settings, commands, or active-tool policy; focused pilot and library suites pass 79/79.
- [x] Verify the already-implemented dynamic screen refresh and cursor restoration regressions remain green; package and pilot checks pass, `npm run check` passes 1,757/1,757 tests, and all three dry-run packs contain only intended files.
- [x] Audit the full PR diff against `docs/extension-conventions.md` and `docs/extension-settings.md`; package, UI, settings transaction, cancellation, disposal, replacement, and shutdown rules have no unaddressed deviation. Replied to and resolved all ten review threads, then pushed `f1b2938`.

## Completion Checklist

- [x] All ten PR review threads are addressed with code, tests, or evidence and resolved on GitHub.
- [x] `npm run check` passes 1,757/1,757 tests.
- [x] Menu, Chrome DevTools, and Firecrawl dry-run packs contain the intended files and metadata.
- [x] The review-fix commit `f1b2938` is pushed to `feat/pi-extension-menu`; the worktree was clean before this plan's archival.
