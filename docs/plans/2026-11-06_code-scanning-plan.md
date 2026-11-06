# Resolve code scanning findings

## Goal

Resolve all open CodeQL findings with targeted code fixes or evidence-based false-positive triage, without changing published runtime behavior.

## Context

- Alerts #29–#41 concern literal hostname assertions, URL comparisons, or terminal-output assertions; #31 traces a runtime URL constant into a test regular expression.
- Alerts #24–#28 flag `JSON.stringify` in generated Node-only test source; the query's HTML `<script>` concern does not apply to those literal contexts.
- Alerts #21–#23 duplicate earlier dismissed findings #10, #9, and #6 after repository path migrations.
- The worktree starts clean at `ce8a19ce`; the latest scan on that commit added alert #44 for an error response in the loopback-only LSP smoke provider, bringing the total to 22.
- Completion work uses the new branch `narumi/fix/complete-code-scanning-plan` from `origin/main`, reusing the reviewed fixes in `7b576828` without changing the original PR branch.
- PR #1820 passed CI and CodeQL; its JavaScript analysis `2109313907` reports zero results. CI ran affected workspaces, so it does not yet establish a passing full repository test gate.

## Applicable rules and verification

- Test fixtures: preserve deterministic tests and test resource cleanup; verify generated scripts with focused tests and inspect all related construction sites (`Test`, `Review`).
- URL and terminal-output assertions: compare complete URL components where URLs are interpreted, keep literal terminal-control checks meaningful, and preserve non-interactive rendering coverage (`Test`, `Review`).
- Security triage: verify random-token generation, loopback binding, cookie attributes, timing-safe comparisons, process-keyed HMAC use, and non-persistence; verify Node-only source contexts against the CodeQL query before dismissing false positives (`Review`, existing `Test`).
- LSP smoke-provider errors: keep diagnostics local and return a fixed response; preserve subprocess readiness deadlines and cleanup (`Review`, package-directory fixture `Smoke`).
- Extension conventions: apply the documentation-and-verification MUST rules; run both `npm run check` (`Validator`) and `npm test` (`Test`).
- Verification environment: run the full unchanged suite without an affected-test base in a separate Linux clone with the Node version from `.node-version`; preserve host files and capture evidence before removing owned container resources (`Test`, `Review`).
- Completion documentation: retain exact gate results, false-positive evidence, semantic audit, and the remaining default-branch merge handoff before deleting this completed plan (`Review`).
- Scope: no metadata, settings, loading, command, lifecycle, UI implementation, or published behavior changes are intended; pack smokes, runtime-loading smokes, and Changesets are not applicable unless that scope changes.

## Plan

- [x] Inspect all 22 alerts against their source, prior triage, and the authoritative CodeQL query; record each affected pattern class.
- [x] Verify #24–#28 are primitive string literals in Node-only fixtures, not HTML; retain correct `JSON.stringify` serialization after independent read-only review.
- [x] Replace hostname and URL test patterns for #29–#41 with complete request equality, parsed URL components, or terminal-control and visible-text assertions; audit related occurrences in all seven files.
- [x] Fix #44 with local stderr diagnostics and a fixed HTTP error body; the package-directory smoke passed diagnostics, preview, write, reload, shutdown, four child-server exits, and eight loopback provider requests. A deterministic error-path probe confirmed that private diagnostic text stays out of the response.
- [x] Dismiss #21–#28 as false positives with per-alert evidence; GitHub confirmed all eight dismissals.
- [x] Run `npm run format`, 368 focused tests across 12 files, and `npm run check`; all passed. The first direct focused run required the canonical temporary-directory environment used by the root test runner; its canonical-path rerun passed.
- [x] Complete the full Linux verification gate: `npm run format` and `npm run check` passed; 501 focused tests passed with one existing platform skip; unfiltered `npm test` selected all 909 files and passed 19,465 tests with 16 existing platform skips, zero failures, and zero unhandled errors. Both LSP smoke paths passed, and the clone stayed unchanged. Initial setup errors and the older-image Git failure remain recorded in the retained verification note.
- [x] Audit the final diff against `docs/extension-conventions.md`, the Kit/LSP scoped rules, all alert locations, URL semantics, terminal-control preservation, and fixture resource cleanup; `git diff --check` passed.
- [x] Re-query GitHub: #21–#28 remain dismissed; analysis `2109313907` verifies zero JavaScript results for `7b576828`. The 14 fixed alerts remain open on `main` until merge and default-branch re-analysis.
- [ ] Write the retained verification note, complete the semantic audit, and remove this plan only after all agent checks pass.
- [ ] Commit and push the focused completion branch, open its pull request, and verify the final CI/CodeQL results without merging or dispatching a release workflow.

## Completion Checklist

- [x] All 22 identified findings have an evidence-backed disposition: 14 local fixes and eight verified false-positive dismissals.
- [x] Focused tests and both full root verification gates passed in the isolated Linux environment; macOS baseline failure evidence remains recorded below and in the retained verification note.
- [x] The diff contains only intended test fixes and completion documentation, without source-level scan suppression, settings changes, metadata changes, or published runtime weakening; no Changeset or pack/load smoke is required.
- [x] GitHub dismissals and zero-result PR re-analysis are confirmed; the 14 code-fixed alerts are not claimed closed on `main` before merge and default-branch re-analysis.
- [ ] Final pull-request checks pass, completion evidence and external handoff are retained, and this completed plan is removed.

## Verification blockers

All four failures reproduced without the patch at `ce8a19ce`:

- `test/background-timer-exit.test.ts`: Fleet rejects the long macOS temporary path because it exceeds the Unix socket path limit.
- `packages/pi-edit-scope/test/menu.test.ts`: two canonical-target assertions expect unwrapped text, but the long macOS temporary paths wrap at the test width.
- `packages/pi-edit-scope/test/paths.test.ts`: the filesystem treats composed and decomposed Unicode filenames as equivalent, contrary to the test's rejection expectation.

The detached baseline worktree was outside the repository and was removed after reproduction. No unrelated source or tests were changed.

## External Handoff

The maintainer owns merge and the resulting default-branch CodeQL run. The PR analysis verifies the patch with zero results, but the 14 alerts must not be reported closed on `main` until that run confirms their closure. No merge, release, or publication is authorized by this plan.

The four macOS-specific baseline failures remain documented. The passing unfiltered Linux run satisfies the plan's suitable-environment test requirement without a waiver or unrelated test changes. Verification evidence and the remaining merge handoff are retained in `docs/implementation-notes/code-scanning-verification.md`.
