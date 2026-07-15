## Goal

Resolve all three findings in the late review on merged PR #173, verify the published pi-goal package, and open a focused follow-up PR.

## Context

The review identifies unsupported TypeScript parameter properties, old-goal ownership leaking into turns while priority activation is pending, and restored queued goals being prompted after their token budget is already exhausted.

## Plan

- [x] Add focused regressions for pending-priority turn ownership, exhausted queued-goal restoration, and erasable published TypeScript; the focused queue suite failed both behavior regressions and pi-goal typecheck reported TS1294 for both parameter properties.
- [x] Apply the smallest fixes in `extensions/pi-goal/src/` and scan adjacent queue/runtime paths for the same patterns; all 35 focused queue tests and pi-goal typecheck pass, including the adjacent stale owned-prompt priority case.
- [x] Run the repository gate, pi-goal runtime smoke, package dry run, and diff checks; `npm run check` passed 493 tests, runtime smoke passed, `just pack-goal` produced the expected 12-file package, and `git diff --check` passed.
- [x] Commit and push the focused branch, open a new PR referencing the late review, and update the old review threads with the follow-up evidence; commit `d312f13` is pushed in PR #207 and both late inline threads on PR #173 are replied to and resolved.

## Risks

- Pending-priority suppression must not abort unrelated user work; tests will distinguish prompt ownership from goal ownership.
- Restored budget-limited goals must remain resumable only after a real budget increase and must not be rewritten by prompt-delivery recovery.

## Completion Checklist

- [x] All three review findings have regression coverage and focused passing checks: 35 queue tests pass and `erasableSyntaxOnly` rejects unsupported published syntax.
- [x] The repository gate, runtime smoke, package dry run, and diff validation pass with the evidence recorded above.
- [x] A focused commit is pushed at `d312f13`, PR #207 links the original review, and PR #173 records the follow-up verification evidence.
