# Pi Goal native retry plan

Status: BLOCKED

Execution branch: `narumi/fix/goal-native-retry`, based on `origin/main` at `b69e94e3`.
The user-provided plan was the only untracked file before execution.

## Goal

Use Pi's native retry classification and execution while retaining Goal waiting, blocked, usage-limited, paused, and safety-limit behavior.
Do not convert every failed provider run into a blocked Goal.

## Context

The reviewed baseline is commit `8b65ea8d`.
The recent persistence change detaches append-time Goal snapshots and does not change retry policy.

Pi already executes provider retries and compaction recovery.
`packages/pi-goal/src/errors.ts` calls Pi's public helpers but also adds retry patterns and quota/authentication exclusions that can disagree with Pi.
`lifecycle.ts` records recovery at `agent_end`; `runtime.ts` preserves automatic ownership across retry `agent_start` events and finalizes recovery at `agent_settled`.
Retain that coordination instead of replacing it with another retry loop or a broad lifecycle rewrite.

## Architecture and scope

- Delegate provider retry classification to Pi's public `isRetryableAssistantError()` helper and overflow classification to `isContextOverflow()`.
- Remove Goal-owned positive and negative retry patterns and prevent Goal's usage-limit classifier from vetoing a retry that Pi permits.
- Keep usage-limit classification only for selecting the final Goal status after Pi's recovery opportunity ends.
- Keep recovery identity, automatic ownership, counters, budgets, continuation cancellation, and compaction `willRetry` coordination.
- Respect `agent_settled.aborted` when cancellation occurs during native backoff without another assistant message.
- Use public extension events and helpers only; SDK `auto_retry_start` and `auto_retry_end` are not extension events.
- Do not change Goal tool schemas, commands, settings, persisted status names, prompt contracts, package dependencies, or Pi core.

| Outcome | Required Goal behavior |
| --- | --- |
| Native provider recovery succeeds | Continue the same eligible Goal without duplicate continuation or lost automatic accounting. |
| Native-classified transient provider failure remains at settlement | Enter deadline-free active waiting; preserve Goal ID, follow-up wake-up, and managed-run ownership. |
| Explicit quota, subscription, credit, or billing failure is final | Select `usage_limited` without preventing native recovery attempts. |
| Native-classified terminal non-usage failure | Keep the existing blocked path and explicit resume requirement. |
| Overflow recovery fails | Keep the existing blocked path rather than provider-exhaustion waiting. |
| User cancels, including during retry backoff | Select `paused`; do not enter waiting or misreport a terminal provider failure. |
| Explicit `goal_wait` or `goal_blocked` call | Preserve its current validation, state, wake-up, and managed-run behavior. |

Retry-disabled and zero-retry settings must not cause Goal to create its own retries.
A native-classified transient error can still enter the existing quiet waiting state when Pi makes no further attempt.
Preserving waiting and blocked does not preserve every old text-pattern outcome: unsupported premature-close wording must follow Pi's classification rather than a Goal fallback.
Document and test that intentional difference.

## Applicable rules and verification

- Lifecycle and recovery changes MUST retain session/Goal ownership, release owned work on cancellation, replacement, and shutdown, and revalidate mutable ownership after asynchronous boundaries; verify with focused lifecycle tests, semantic review, and the deterministic runtime smoke.
- State changes MUST preserve append-time persistence snapshots and rebuild branch-owned state correctly; verify with persistence, restore, wait, and managed-run tests.
- Ordinary turns MUST retain model-visible prompt prefixes and ordered tool definitions; verify with Goal cache-contract and tool-policy tests plus diff review.
- Provider error text MUST remain bounded, terminal-safe, and untrusted in notifications and resume prompts; verify with existing sanitization tests and new final-status cases.
- Published behavior changes MUST include deterministic tests and a Changeset; verify with focused tests and Changesets status.
- Apply `docs/extension-conventions.md`, `packages/pi-goal/AGENTS.md`, and `docs/readme-conventions.md`; verify touched-area rules, README headings, and documentation scope before handoff.

## Plan

- [x] Inspect current Goal recovery, Pi's installed public helpers and event contract, and the recent snapshot commit; establish that native helper delegation can retain the existing state machine.
  Evidence: `errors.ts` has duplicate retry rules, `runtime.ts` owns waiting/blocked finalization, and Pi's extension events expose settlement and compaction recovery without exposing SDK retry events.
- [x] Prepare the execution baseline with `npm install`, confirm no unintended manifest or lockfile changes, read the relevant Pi extension documentation and compaction example in full before runtime edits, and build `pi-tui-kit` before consumer tests.
  Evidence: installation reports zero vulnerabilities and no tracked changes; Kit build passes. Read the extension, settings, and README guides, package AGENTS, Pi extension and compaction references, and custom-compaction example in full.
- [x] Add table-driven native-helper parity tests and capture expected failures before source changes; cover supported transient errors, unsupported premature-close text, quota/authentication mixed with retry wording, overflow, missing errors, and non-error stop reasons.
  Evidence: `npx vitest run packages/pi-goal/test/errors.test.ts` produced 21 expected failures and 86 passes before source changes; failures cover Goal-only positive patterns, Goal quota/authentication vetoes, and Pi's native account-limit exclusions.
- [x] Replace only Goal's duplicate retry classification with Pi helper delegation, retain usage-limit classification as terminal-state policy, and verify focused classifier tests pass.
  Evidence: native-helper parity passes, including native account-limit exclusions and mixed quota/authentication wording; no Goal retry patterns or retry loop remain.
- [ ] Add and pass lifecycle regressions for native recovery success, exhausted or disabled provider retry entering waiting, final quota status, terminal blocking, compaction success/failure, backoff cancellation, replacement/shutdown, and unchanged explicit wait/block tools.
  Preserve automatic ownership, response-cap precedence, token-budget stops, compaction `willRetry` handling, and exactly-once continuation; include native recoverable-length compaction when auditing recovery ownership.
  Evidence: all 30 Goal test files pass (539 tests). Read-only semantic review found pre-promotion cancellation and manual-steer ownership races; six tests failed before their fixes and now pass. Three native compaction-only cancellation regressions also failed before their fix and now pass. Length recovery follows native compaction events and clears with provider recovery. Native retry-only cancellation remains blocked by Pi's missing public signal.
- [ ] Extend the existing fake-provider runtime smoke to prove actual native retry attempts and cancellation ordering without live-provider requests; verify no extra Goal retry loop and no continuation before native recovery settles.
  Evidence: the normal smoke passes native retry success/exhaustion/disabled/zero, mixed quota/authentication cases, full session abort during backoff, managed waiting, and native length compaction success/failure/compaction-only cancellation. A separate deterministic `abortRetry()` probe fails the required paused outcome: settlement reports `[false, false]`, Goal remains active/waiting, and exactly two provider calls occurred. This is a public-event blocker, not a passed cancellation check.
- [x] Update the package README and continuation lifecycle reference, add a patch Changeset, and audit active README headings; document native classification authority and changed unsupported-error outcomes without changing waiting/blocked contracts.
  Evidence: fenced-code-aware headings, standard labels, and required order pass for all 37 active package READMEs; the Goal badges/warnings/interfaces remain intact. Changesets status selects only a Goal patch; its existing advisory about the unrelated edit-scope Kit floor remains unchanged.
- [x] Run focused Goal error, safety, budget, wait, persistence, managed-run, workflow-mutex, tool-policy, cache-contract, and generated-entry tests; then run `npm run check` and `npm test` separately and sequentially, plus `npm --workspace @narumitw/pi-goal run test:runtime`.
  Do not run root checks concurrently with a Kit build or check; record exact failures instead of increasing test timeouts or waiving required gates.
  Evidence: local `npm run check`, full test compilation, all 30 Goal test files (539 tests), and `test:runtime` pass. A read-only source copy in an isolated Linux container also passes `npm run check`, followed separately by full `npm test`: 19,625 passed, 16 platform skips, no failures. That environment uses the manifest-pinned Node version, Git with sparse-checkout support, a non-root user, an init reaper, and `SHELL=/bin/bash`; its temporary containers were removed.
  Earlier failures remain recorded: macOS full tests had four failures outside Goal (Fleet Unix-socket path length, two edit-scope wrapped-path assertions, and Unicode normalization). Short `TMPDIR` fixes the first three; macOS normalization still resolves composed `café.txt` to an existing decomposed name. The first Linux setup exposed five environment failures from missing SHELL, root permissions, old Git, and no PID reaper; all five pass after preparing the environment correctly. No test timeout, skip, repository source, or mandatory gate was weakened.
- [x] Build and load the packaged runtime through a non-interactive Pi smoke, exercise a representative lazy boundary, inspect `git diff --check` and the complete intended diff, and record semantic audit/check/smoke evidence before handoff.
  Evidence: package-directory loading with isolated agent state, offline mode, and `pi --no-extensions -e ./packages/pi-goal --print "/goal clear"` passes. The generated-runtime Jiti test loads the lazy menu, and generated-import validation passes. `npm run package:pack -- goal` and an actual temporary tarball inspection confirm the expected 39 source/runtime/docs/license files, including the lazy menu chunk. Diff whitespace checks pass. The semantic audit covers correctness, security, lifecycle, compatibility, regressions, and scope; native retry-only cancellation remains an explicit acceptance blocker.

## Risks

Pi's native classifier can differ from Goal's removed fallbacks in both directions.
Do not restore private error-pattern exceptions merely to preserve old tests.
Moving usage-limit policy must not turn explicit quota exhaustion into indefinite provider waiting.
Cancellation during backoff can leave the last assistant message as an error, so settlement cancellation must take precedence.
Deleting recovery tracking can lose automatic ownership or permit duplicate continuations even though Pi still retries correctly.

## Rollback / Recovery

Restore only the intended source, test, documentation, and Changeset edits if the focused recovery regressions fail.
Keep unrelated work and the existing persisted Goal format unchanged; no data migration, publication, tags, or release dispatch is authorized by this plan.

## External Handoff

The maintainer must decide whether to authorize prerequisite work or approve a documented acceptance exception before this plan can complete.
Pi's public API must expose retry-only cancellation (for example, through `agent_settled.aborted`) to meet the existing universal cancellation criterion without private SDK events or a core/dependency change.
The installed TUI Escape handler and RPC `abort_retry` call `abortRetry()`, which aborts only the retry controller, does not abort the agent signal, and emits no distinct extension event.
A full-session-abort smoke cannot prove native retry-only cancellation.
No release or completion claim is permitted while this criterion remains unresolved.

The unrelated macOS Unicode-path failure remains outside this change; the complete Linux repository gates pass without a waiver or source changes.
The plan is retained in the draft pull request, which must not be marked complete or ready to merge until the native cancellation criterion has an approved disposition.

## Completion Checklist

- [x] Goal delegates retry eligibility to Pi without duplicate retry patterns or a new retry loop.
- [ ] Waiting, blocked, usage-limited, cancellation, compaction, ownership, budgets, and safety limits have passing regression evidence.
- [x] Explicit Goal tools, persisted snapshots, managed-run events, and model-visible prefix contracts remain correct.
  Evidence: the complete focused Goal suite passes; no tool schema, command, setting, persisted format, dependency, or prompt-contract change is present.
- [ ] Focused tests, root checks/tests, deterministic runtime smoke, and packaged-runtime loading pass with recorded evidence.
- [ ] Documentation, Changeset, and final semantic review match the implementation; delete this plan only after all required work and checks are complete.
