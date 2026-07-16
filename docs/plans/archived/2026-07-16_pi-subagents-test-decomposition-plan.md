## Goal

Split `extensions/pi-subagents/test/evolution.test.ts` into cohesive test modules under 1,000 lines without changing test behavior or coverage.

## Context

The merged test file is 2,101 lines and spans protocol/context helpers, registry persistence, stateful orchestration, subprocess running, rendering, and process cleanup.

## Plan

- [x] Record the baseline test inventory and verification result; `npm test` passed 505 tests and `evolution.test.ts` contains 44 test declarations.
- [x] Move tests unchanged into responsibility-based modules for context/protocol, registry/persistence, orchestration/stateful behavior, and runner/rendering; all files are 842 lines or fewer and the 44 unique test names match exactly.
- [x] Run focused pi-subagents tests and the repository verification gate, inspect the final diff for move-only behavior, then commit, push, and open a PR; commit `0dfbb00` is in PR #216 and both CI jobs passed.

## Risks

- Tailored imports can accidentally omit runtime dependencies or retain unused symbols; TypeScript and Biome must pass.
- Mechanical range moves can lose or duplicate tests; compare declaration inventories and total passing test count.

## Completion Checklist

- [x] No pi-subagents test source exceeds 1,000 lines; `wc -l` reports a maximum of 842 lines.
- [x] The original 44 test declarations and 505 passing repository tests are preserved.
- [x] Both PR #216 CI jobs pass and the implementation commit leaves only this completed plan to archive.
