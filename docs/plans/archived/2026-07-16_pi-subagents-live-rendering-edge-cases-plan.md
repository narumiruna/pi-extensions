## Goal

Harden PR #213 so compact subprocess progress remains meaningful when assistant text has surrounding whitespace and terminal timeout updates are not mislabeled as running.

## Plan

- [x] Add focused regressions for whitespace-heavy recent activity and partial timeout rendering; `npm test` failed on both new assertions before production changes.
- [x] Normalize compact assistant text before bounding it and classify timeout state through the shared result-error helper; both focused regression tests pass after recompilation.
- [x] Scan single, chain, parallel, and fan-in callers for the same status/rendering assumptions, then run the repository verification gate; all routes use the shared helpers and `npm run check` passed 504 tests.

## Risks

- Whitespace normalization must remove only outer padding and preserve internal formatting.
- Timeout classification must not mark ordinary in-progress results as failed.

## Completion Checklist

- [x] Meaningful compact text survives large leading/trailing whitespace, proven by the `LATEST_ACTIVITY` regression assertion.
- [x] A timed-out partial result renders as an error rather than running, proven by the timeout render regression assertions.
- [x] `npm run check` passes 504 tests, `git diff --check` passes, and the final diff contains only intended PR follow-up changes.
