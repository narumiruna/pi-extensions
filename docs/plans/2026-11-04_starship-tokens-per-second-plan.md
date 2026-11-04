# Starship tokens-per-second implementation

## Goal

Resolve [issue #1803](https://github.com/narumiruna/pi-extensions/issues/1803) by adding an opt-in `tokens_per_second` module to `@narumitw/pi-starship` with the approved full module name.

## Context

The issue is an open feature request with the `enhancement` label, no discussion, and no linked implementation context.
The current module catalog has token totals but no response-rate module.
Pi persists assistant `usage.output` and optional `durationMs`; its event stream measures response duration with a monotonic clock.
Legacy responses and some deferred results have no duration.
Pi emits `message_end` before persistence, while existing footer refreshes at tool execution and turn boundaries can read persisted responses.
Use those existing refreshes rather than adding asynchronous state or timing hooks.

## Accepted behavior

- The root format accepts `$tokens_per_second`, configured through `[tokens_per_second]`.
- The module exposes `$symbol` and `$rate`, plus `$style` in style expressions.
- Defaults are `disabled = true`, `symbol = ""`, `style = "bold cyan"`, and `format = "[$rate tok/s ]($style)"`.
- Calculate the rate from the latest finalized assistant response on the active branch as `usage.output / (durationMs / 1000)` and show one decimal place.
- This is response-average output throughput, including request latency and thinking time, not streaming/decode-only speed; output counts retain the provider's semantics, including reasoning tokens when included by the provider.
- Keep the previous completed response's rate while a new response is in progress; do not estimate partial usage.
- Accept only completed `stop`, `length`, and `toolUse` responses; hide aborted, failed, pending, deferred, or unknown outcomes, missing/nonfinite/nonpositive duration, missing/nonfinite/negative output, or a nonfinite calculated rate without falling back to an older response.
- Display valid zero output as `0.0 tok/s`.
- Restore the correct branch-local value after resume, reload, fork, and tree navigation without adding persisted entries.
- Preserve existing cumulative token/cache/cost accounting, native-footer behavior, presets, and `$all` output unless the new module is explicitly enabled.

## Scope and applicable rules

| Area | Applicable MUST rules | Verification |
| --- | --- | --- |
| Module, configuration, and rendering | Follow `docs/extension-conventions.md` and `docs/extension-settings.md`; use the catalog-owned schema, preserve existing defaults, keep rendering pure and width-bounded, and add deterministic coverage. | Test: module validation, rendering, `$all`, inspection, invalid data, and narrow/zero widths. Review: source/catalog boundaries and no dependency or grammar changes. |
| Response data and lifecycle | Reconstruct branch-sensitive state from the active branch, keep factory loading free of session work, and preserve shutdown/replacement safety; do not alter model-visible context. | Test: latest response, failures, branch changes, session replacement, non-TUI modes, and disposal. Review: installed Pi event ordering and no new timers, tasks, context hooks, or resources. |
| User documentation | Follow `docs/readme-conventions.md`; keep one authoritative semantic explanation, preserve README structure, and align the skill catalog with the implementation. | Test: existing catalog/schema tests. Review: fenced-code-aware README heading audit, links, defaults, formula, and limitations. |
| Published behavior and generated runtime | Record a package-specific Changeset; preserve generated entrypoints, import paths, and lazy boundaries. | Test: generated-entry and build-runtime tests. Validator: `npm run check` and `npm test`. Smoke: package build, pack inspection, and non-interactive Pi/Jiti loading. |

No new commands, settings files, environment variables, dependencies, aliases, presets, project-local extensions, or issue metadata writes are in scope.
Do not publish packages, tag a release, or close the issue.

## Plan

- [x] Inspect the complete issue, repository guidance, existing module design, Pi timing fields, and authoritative event ordering; record the approved name and response-average semantics above.
- [x] Add focused regression tests and observe a failing test against the existing implementation before adding executable behavior; the initial run failed 7 of 8 tests with unknown module/variable diagnostics and missing module inspection.
- [x] Implement a branch-local rate resolver in `src/usage.ts`, an optional runtime snapshot value, and the catalog-owned `src/modules/tokens-per-second.ts`; focused tests cover all installed Pi stop reasons, numeric validation, invalid latest-response clearing, and unchanged totals.
- [x] Add isolated lifecycle coverage for persisted response refreshes, active-branch selection, replacement/reload, failure/cancellation, disposal, and non-TUI behavior; 14 lifecycle tests pass without provider calls.
- [x] Update the README entry point and bundled module references, and add a minor Changeset for the opt-in public module; all 18 bundled-skill tests pass, including exact catalog/schema coverage; the structural README audit remains part of final verification.
- [x] Review and harden the complete diff, including independent review; no defects were reported, and the recommended generated-package `AgentSession` integration test now verifies real event ordering, tool/turn refreshes, and disk-backed response timing.
- [ ] Finish the full-suite gate: package tests, `npm run check`, pack inspection, README audit, and the non-interactive Pi smoke pass, but `npm test` has an unchanged Fleet Unix-socket path failure on this macOS checkout; see verification evidence below.
- [ ] Recheck acceptance criteria, stage only intended implementation paths, inspect the index, commit with Conventional Commits, push this feature branch, and open a PR with `Closes #1803`, verification, and limitations.

## Verification evidence

- Initial regression run: 7 of 8 module tests failed before implementation, with unknown module/variable diagnostics and absent module inspection.
- Pinned runtime: `fnm exec --using=26.11.1 npm run check` passes; existing informational Biome schema/continue notices remain unchanged.
- Package gate: `TMPDIR=/private/tmp fnm exec --using=26.11.1 npm exec -- vitest run packages/pi-starship/test` passes all 65 files, with 2,329 tests passed and one existing platform skip.
- Full `npm test` completed 879 files: 877 passed, 18,712 tests passed, one Fleet test failed, and 35 tests skipped; the additional Version PR suite failure was a Node-version mismatch (`26.10.0` versus the repository pin), and both tests pass when rerun with the pinned Node.
- Remaining full-gate failure: `test/background-timer-exit.test.ts` supplies a temporary base path that exceeds Pi Fleet's 103-byte Unix socket limit after macOS canonicalizes it; both that test and `packages/pi-fleet/src/runtime-directory.ts` are unchanged from HEAD. The probe passes with literal `TMPDIR=/tmp`, but the root runner resolves it to `/private/tmp`, where it still fails. No unrelated Fleet code or tests were changed.
- `npm run package:pack -- starship` passes; an actual tarball was inspected and removed, confirming all 170 files, the new source, generated entry, skill references, README/changelog/license, and exclusion of tests; no publication occurred.
- The package-directory Pi RPC smoke loads the declared generated Jiti entry with valid new settings, opens lazy status/help routes, makes no provider request, and exits cleanly.
- A fenced-code-aware README heading audit passes for all 37 package manifests; exact bundled catalog/schema tests pass; Changesets selects only a minor release of `@narumitw/pi-starship`.
- Semantic audits: the synchronous branch-derived value adds no asynchronous tasks, timers, UI keys, model-visible context, or persistence; session ownership, cancellation, replacement, disposal, native-footer defaults, settings reads/writes, unknown-field preservation, and cumulative accounting remain unchanged.
- Physical-terminal appearance and live-provider timing were not tested: interactive commands are disallowed for this task, and the deterministic fake-provider/Jiti test covers the runtime without network or account usage.

## Risks and limitations

Missing response durations cannot be reconstructed reliably; leave those responses hidden instead of estimating wall time or token counts.
Provider output-token definitions differ, so the module must not claim visible-text-only or decode-only speed.
The deterministic non-interactive smoke cannot prove physical-terminal appearance or live-provider timing accuracy.
No persistent data format changes are needed; rollback is removal of the optional module reference or reverting the implementation.

## What looks good

The module fits the existing catalog and format grammar, uses Pi's persisted timing, requires no new runtime resources, and leaves current layouts unchanged by default.

## What looks bad

Older and untimed responses cannot supply a rate, even when their output counts are present.

## Verdict

**Incomplete:** The approved feature, documentation, package verification, and review are complete, but the full-suite gate still fails in an unchanged macOS Fleet fixture. Keep this plan until that gate passes through CI or a separately approved fixture correction; PR creation is next.

## Completion Checklist

- [x] Regression tests fail before the implementation and pass afterward; all 53 new tests and the complete package suite pass, including real event delivery and disk-backed timing.
- [x] Valid responses show the documented rate; invalid latest responses hide it without using older values.
- [x] Branch/session changes and cancellation cannot leak a stale rate, and existing totals/defaults remain unchanged.
- [x] Documentation, module inspection, and the Changeset match the implemented interface.
- [x] Independent review findings and applicable semantic audits are resolved.
- [ ] Required checks, package inspection, and non-interactive runtime smoke pass; physical/live-provider limits are stated.
- [ ] The commit and PR contain only intended paths, use the required formats, and link the issue with `Closes #1803`.
- [ ] Complete handoff, then remove this completed tracking document under the plan lifecycle rule.
