# Pi TUI Kit Follow-up Review Plan

## Goal

Resolve all three follow-up review threads on PR #446 while completing the approved package rename to
`@narumitw/pi-tui-kit`, preserving consumer behavior, and pushing one focused reviewed change.

## Context

The follow-up review found three lifecycle/build issues: external busy-view disposal can reopen an
obsolete menu, clean consumer typechecks can race or run before generated declarations exist, and a
rejecting error reporter can strand busy UI or escape documented runtime results.

## Plan

- [x] Add focused failing regressions for external busy-view disposal and rejecting error reporters.
      Evidence: all three focused tests failed against the prior runtime—the disposed loader reopened
      the old menu, and both busy-action and state-load paths escaped with the reporter rejection.
- [x] Update the Pi TUI kit runtime to distinguish user cancellation from external busy-view
      disposal and to contain reporter failures while settling busy tasks on both fulfillment and
      rejection. Evidence: four focused lifecycle tests pass, including preserved user cancellation,
      stale external disposal, busy reporter rejection, and state-load reporter rejection.
- [x] Make clean root typechecks build publishable workspace output first and make the parallel
      repository gate build once before typecheck/test consumers. Evidence: four orchestration tests
      pass, and after deleting `packages/pi-tui-kit/dist`, standalone `npm run typecheck` rebuilt the
      kit before both pilots and completed successfully.
- [x] Re-run the kit check, pilot typechecks, boundary checks, full `npm run check`, and all three
      relevant dry-run packs; audit cancellation, disposal, replacement, shutdown, settings
      ownership, package metadata, and publishing behavior against repository conventions. Evidence:
      all gates pass with 1,764 tests, all packs contain their intended files and renamed dependency,
      and a clean offline install imports the compiled ESM API. No new deviation was accepted.
- [x] Commit and push the focused rename/review fixes, reply to and resolve every open review thread,
      and update PR metadata. Evidence: `ebe780b` is on `origin/feat/pi-extension-menu`, PR #446 is
      titled for Pi TUI Kit, and all 15 review threads are resolved with no additional page.

## Completion Checklist

- [x] External busy-view disposal drains owned work and returns stale without reopening an old menu.
- [x] Error reporter rejection cannot strand UI or make documented runtime error paths reject.
- [x] Clean standalone and CI-equivalent typechecks cannot race missing generated declarations.
- [x] `@narumitw/pi-tui-kit` and both pilots pass all required checks and pack inspections.
- [x] All 15 PR review threads are resolved and the implementation branch is pushed; only this
      completed plan remains locally for its required archival commit.
