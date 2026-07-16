## Goal

Resolve all PR #215 review feedback so timed-out parallel tasks and fan-in agents render as terminal failures rather than running while process cleanup finishes.

## Plan

- [x] Add focused regressions for timed-out parallel-task and fan-in partial updates; the focused test failed on the parallel timeout still rendering `(running...)` before production changes.
- [x] Make parallel running/failure classification error-aware and show terminal error details instead of `(running...)`; the focused renderer test passes for task and fan-in timeouts.
- [x] Scan single, chain, parallel, and fan-in rendering, run the repository verification gate, resolve the review thread, and push the update; `npm run check` passed 505 tests, commit `04df386` was pushed, the thread was resolved, and both CI jobs passed.

## Risks

- Successful final partial updates should retain their existing running state until the tool result settles.
- Other active parallel tasks must keep the aggregate header running even if one task has already failed.

## Completion Checklist

- [x] Timed-out parallel-task partials render as failed without running text, proven by regression assertions.
- [x] Timed-out fan-in partials render as failed without running text, proven by regression assertions.
- [x] `npm run check` passed 505 tests, both CI jobs passed, and the only review thread is resolved.
