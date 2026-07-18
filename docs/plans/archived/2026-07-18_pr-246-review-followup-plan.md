## Goal

Resolve every actionable review comment left on merged PR #246 and publish the fixes in a new
draft pull request.

## Context

The thread-aware GitHub review read found two unresolved behaviors in `pi-subagents`: native
provider registrations are not copied into child runtimes, and the `max` model thinking suffix is
not accepted by the parser and shared settings schema.

## Plan

- [x] Classify all PR #246 comments and isolate the two actionable findings; verified by the
  thread-aware review result in `/tmp/pr246-comments.json`.
- [x] Add focused regression tests for native provider propagation and the `max` thinking suffix;
  verified by failures for the missing native registration, unresolved `:max` model id, and absent
  schema enum value before implementation.
- [x] Implement the smallest shared runtime and schema changes that satisfy both findings; verified
  by the focused TypeScript build and four passing targeted `pi-subagents` tests.
- [x] Scan adjacent provider-copy and thinking-level consumers for the same compatibility gap;
  verified with `rg`; the only adjacent bug was inherited `max` being downgraded to `xhigh`, now
  fixed through the shared `isThinkingLevel` guard.
- [x] Exclude repository-local `worktrees/` from Git and Biome discovery; verified with
  `git check-ignore -v worktrees/image-drop/biome.json`.
- [x] Run the repository CI-equivalent gate and inspect the final diff; verified with
  `npm run check` under Node 24/npm 11.16.0 (611 tests), `git diff --check`, and explicit-path
  diff review; the same full gate passed against Pi 0.79.10 and 0.80.3 (610 passing, one
  version-gated skip each).
- [x] Commit only intended files, push the follow-up branch, and open a draft PR against `main`;
  verified by GitHub draft PR #247: `https://github.com/narumiruna/pi-extensions/pull/247`.

## Completion Checklist

- [x] Both actionable PR #246 findings have regression coverage and passing implementation.
- [x] No unresolved same-pattern gap remains in the bounded `pi-subagents` flow.
- [x] The full repository check passes under the CI-pinned Node 24/npm 11.16.0 toolchain.
- [x] Draft PR #247 targets `narumiruna/pi-extensions:main` from
  `agent/address-pr-246-review-comments`.
