## Goal

Resolve the PR #204 review findings so subprocess subagents preserve complete terminal text, retain provider errors, and classify failures consistently across single, chain, parallel, and fan-in flows.

## Plan

- [x] Add regression tests for empty provider errors, provider failures with partial output, and multi-block assistant text; the fan-in assertion failed before implementation by reporting the provider error as completed.
- [x] Centralize subagent failure classification and formatting, preserve provider error details, join all assistant text blocks, and apply the shared behavior to parallel, fan-in, and render output; targeted regression tests passed.
- [x] Run the repository verification gate and inspect the package contents; `TMPDIR="$(realpath "${TMPDIR:-/tmp}")" npm run check` passed 403 tests and `npm run pack:subagents -- --json` verified 23 package entries.
- [x] Review the final diff, commit only intended paths, and push to the PR head branch; PR #204 reports commit `e8a316e`.

## Risks

- Changing failure classification could alter partial-success summaries; preserve the existing policy that parallel mode itself may return partial results while accurately labeling each failed result.
- Combining text blocks and error context must remain within existing UTF-8 byte limits.

## Completion Checklist

- [x] Empty provider errors retain their original `errorMessage`, proven by the `RATE_LIMIT_DETAIL` regression assertion.
- [x] Provider failures are labeled failed and expose both error and partial output in fan-in/parallel paths, proven by unit and tool integration tests.
- [x] Multi-block assistant messages preserve all text within the output byte limit, proven by the `FIRST\nSECOND` regression assertion.
- [x] Full checks and package dry-run pass, and PR #204 contains pushed fix commit `e8a316e`.
