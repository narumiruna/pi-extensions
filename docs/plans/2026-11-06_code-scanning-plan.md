# Resolve code scanning findings

## Goal

Resolve all open CodeQL findings with targeted code fixes or evidence-based false-positive triage, without changing published runtime behavior.

## Context

- Alerts #29–#41 concern literal hostname assertions, URL comparisons, or terminal-output assertions; #31 traces a runtime URL constant into a test regular expression.
- Alerts #24–#28 flag `JSON.stringify` in generated Node-only test source; the query's HTML `<script>` concern does not apply to those literal contexts.
- Alerts #21–#23 duplicate earlier dismissed findings #10, #9, and #6 after repository path migrations.
- The worktree starts clean at `ce8a19ce`; the latest scan on that commit added alert #44 for an error response in the loopback-only LSP smoke provider, bringing the total to 22.

## Applicable rules and verification

- Test fixtures: preserve deterministic tests and test resource cleanup; verify generated scripts with focused tests and inspect all related construction sites (`Test`, `Review`).
- URL and terminal-output assertions: compare complete URL components where URLs are interpreted, keep literal terminal-control checks meaningful, and preserve non-interactive rendering coverage (`Test`, `Review`).
- Security triage: verify random-token generation, loopback binding, cookie attributes, timing-safe comparisons, process-keyed HMAC use, and non-persistence; verify Node-only source contexts against the CodeQL query before dismissing false positives (`Review`, existing `Test`).
- LSP smoke-provider errors: keep diagnostics local and return a fixed response; preserve subprocess readiness deadlines and cleanup (`Review`, package-directory fixture `Smoke`).
- Extension conventions: apply the documentation-and-verification MUST rules; run both `npm run check` (`Validator`) and `npm test` (`Test`).
- Scope: no metadata, settings, loading, command, lifecycle, UI implementation, or published behavior changes are intended; pack smokes, runtime-loading smokes, and Changesets are not applicable unless that scope changes.

## Plan

- [x] Inspect all 22 alerts against their source, prior triage, and the authoritative CodeQL query; record each affected pattern class.
- [x] Verify #24–#28 are primitive string literals in Node-only fixtures, not HTML; retain correct `JSON.stringify` serialization after independent read-only review.
- [x] Replace hostname and URL test patterns for #29–#41 with complete request equality, parsed URL components, or terminal-control and visible-text assertions; audit related occurrences in all seven files.
- [x] Fix #44 with local stderr diagnostics and a fixed HTTP error body; the package-directory smoke passed diagnostics, preview, write, reload, shutdown, four child-server exits, and eight loopback provider requests. A deterministic error-path probe confirmed that private diagnostic text stays out of the response.
- [x] Dismiss #21–#28 as false positives with per-alert evidence; GitHub confirmed all eight dismissals.
- [x] Run `npm run format`, 368 focused tests across 12 files, and `npm run check`; all passed. The first direct focused run required the canonical temporary-directory environment used by the root test runner; its canonical-path rerun passed.
- [ ] Complete the `npm test` gate: the full run had 19,444 passing tests, 34 skipped tests, and four failures outside the diff. All four reproduced at unchanged `ce8a19ce` in a detached external worktree; no exception is approved.
- [x] Audit the final diff against `docs/extension-conventions.md`, the Kit/LSP scoped rules, all alert locations, URL semantics, terminal-control preservation, and fixture resource cleanup; `git diff --check` passed.
- [x] Re-query GitHub: only #29–#41 and #44 remain open, with local fixes awaiting CodeQL re-analysis. Keep this plan because the required test gate remains incomplete.

## Completion Checklist

- [x] All 22 identified findings have an evidence-backed disposition: 14 local fixes and eight verified false-positive dismissals.
- [ ] Focused tests and both root verification gates pass; blocked only on the four reproduced baseline failures below.
- [x] The diff contains only intended test changes, without source-level scan suppression, settings changes, metadata changes, or published runtime weakening; no Changeset or pack/load smoke is required.
- [x] GitHub dismissals are confirmed; the 14 code-fixed alerts are not claimed closed before re-analysis.

## Verification blockers

All four failures reproduced without the patch at `ce8a19ce`:

- `test/background-timer-exit.test.ts`: Fleet rejects the long macOS temporary path because it exceeds the Unix socket path limit.
- `packages/pi-edit-scope/test/menu.test.ts`: two canonical-target assertions expect unwrapped text, but the long macOS temporary paths wrap at the test width.
- `packages/pi-edit-scope/test/paths.test.ts`: the filesystem treats composed and decomposed Unicode filenames as equivalent, contrary to the test's rejection expectation.

The detached baseline worktree was outside the repository and was removed after reproduction. No unrelated source or tests were changed.

## External Handoff

The user authorized committing, pushing, and opening a pull request. A successful CodeQL analysis must verify that revision; the expected result is closure of #29–#41 and #44 without new alerts after merge to the default branch. GitHub analysis of the patch remains unverified, and the remaining alerts must not be reported closed yet.

The maintainer must resolve the four baseline test failures, obtain a passing full run in a suitable environment, or explicitly approve an exception before the required test gate can be marked complete. No exception, release, or publication is authorized by this plan.
