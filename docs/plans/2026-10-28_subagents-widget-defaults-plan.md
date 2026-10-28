# Subagents widget defaults

## Goal

Use the selected single-line task-first widget layout. Hide Job ID and tools by default. Show thinking only when it differs from the main agent's effective thinking level captured at spawn. Keep saved display overrides and child execution unchanged.

## Context

`src/tools.ts` resolves thinking after attachment validation. `src/runtime.ts` owns active-job snapshots, and `src/widget-renderer.ts` owns row content. Capture the spawn default as plain job metadata; do not compare with mutable parent settings during rendering. Running rows show elapsed time and an optional timeout. Queued rows show `queued` and an optional timeout instead of elapsed time. Compact item views retain their existing purpose of hiding details.

## Applicable rules and verification

- Widget rendering MUST use the callback theme, the standard `borderMuted` separator, bounded terminal-cell widths, and the existing session-owned key; verify with renderer, resize, presentation, and non-TUI tests plus lifecycle review.
- Settings changes MUST follow `docs/extension-settings.md`, keep side-effect-free defaults and existing user overrides, preserve unknown fields and atomic ordered writes, and retain failure recovery; verify with settings and settings-UI tests and a read/write audit.
- Spawn metadata MUST be read only during an active session, remain stable across parent changes, and stay out of child requests, inspection, completion, and model-visible prefixes; verify with spawn integration tests and a diff review.
- Documentation MUST follow `docs/readme-conventions.md`, preserve warnings and supported interfaces, and match implemented defaults; verify with a fenced-code-aware README heading audit and review.
- Published behavior MUST have a Changeset and deterministic tests; verify with focused tests, `npm run check`, `npm test`, and a package-directory Pi load smoke without a provider request.
- No new asynchronous flow, keyboard handler, entrypoint, dependency, settings storage path, or model-visible contract is required; verify these boundaries in the final diff.

## Plan

- [x] Capture each job's spawn-time default thinking level without changing the child configuration or public tool contracts; cover inherited, equal explicit, and different explicit levels.
- [x] Apply the task-first layout, conditional thinking, and new code defaults while retaining saved user overrides; update focused settings, UI, renderer, and lifecycle tests.
- [x] Update the README and add a patch Changeset; confirm the documented layout and persistence behavior against tests.
- [ ] Run focused tests, both root gates, the README audit, and a generated-package Pi load smoke; audit the final diff against the touched rules.

## Completion Checklist

- [x] Default rows hide IDs, tools, redundant running text, and unset timeout text.
- [x] All supported thinking levels hide only when equal to their captured default, including explicitly supplied equal values; later parent changes do not change existing rows.
- [x] Queued/running rows, saved overrides, compact/hidden modes, empty tasks, sanitization, narrow layouts, and non-TUI operation remain correct.
- [ ] Required checks pass and the handoff records the applicable guides, audits, smokes, and unverified external behavior.

## Verification evidence

The final package suite and root lifecycle file pass 487 tests across 20 files. The final `npm run check` passes after rebuilding every workspace. A fenced-code-aware audit confirms required README headings and order across all 37 packages, and the changed README retains its badges and installation warnings. A static review found no actionable issue.

The semantic audit follows `docs/extension-conventions.md`, `docs/extension-settings.md`, and `docs/readme-conventions.md`: session cancellation, disposal, replacement, and shutdown retain their existing ownership paths; settings reads and writes retain ordering, failure recovery, invalid-file protection, unknown-field preservation, and atomic publication. Spawn defaults remain job-local display metadata, with no model-visible prefix transition or changed child request. No dependency, manifest, entrypoint, or persistence path changed, so a metadata pack smoke is not applicable.

The offline package-directory smoke passed through `pi --mode rpc --no-extensions -e ./packages/pi-subagents`, including session startup, the generated lazy manager, mixed settings defaults, the direct settings route, and orderly shutdown without a provider request or settings-file creation. An interactive TUI visual review is not available through the non-interactive command harness.

The initial full `npm test` exceeded the Bash call's 300-second limit. A background rerun reused the successful prerequisite build and completed 15,523 tests: 15,490 passed, 13 failed, and 20 skipped. Eleven failures were root lifecycle assertions that used the now-optional thinking text as a detail marker; those assertions now use task-row evidence, and all 22 tests in that file pass in the final focused run.

Two failures remain outside the change scope and reproduce in a separate run against unchanged package files:

- `packages/pi-codex-imagegen/test/artifacts.test.ts`: missing symlink directory expects `ENOENT`, but preflight reports `EISDIR`.
- `packages/pi-starship/test/settings-draft.test.ts`: cleanup permission failure expects `EACCES` or `EPERM`, but the host reports `ENOTEMPTY`.

The full-suite gate remains open. The saved plan is retained rather than marked complete or deleted.

## External Handoff

The maintainer must repair the two unrelated baseline failures, or authorize a verification exception, before the full-suite gate and this plan can close. The prerequisite evidence is recorded above; the expected result is a passing full `npm test` on the target platform. No exception or release approval has been granted.
