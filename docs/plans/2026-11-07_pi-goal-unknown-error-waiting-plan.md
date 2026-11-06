# Pi Goal unknown-error waiting

## Goal

Extend PR #1834 on `narumi/fix/goal-native-retry` so an unclassified assistant error keeps its Goal active in deadline-free waiting without adding a retry, a retry text matcher, or a new setting.

## Context

PR head `eda8c1aa` delegates retry eligibility to Pi and improves cancellation and native length-recovery ownership. Its terminal fallback regresses the published #1821 premature-close fixture and part of historical PR #1324. The user approved changing that fallback to quiet waiting, including the tradeoff that invalid-request, authentication, and unrecognized account-limit errors may also wait. This does not authorize changes to Pi core, providers, settings, or release workflows.

## Behavior Contract

- Pi alone decides and executes provider retries and compaction recovery, including retry settings, backoff, disabled/zero budgets, and retry-only cancellation.
- A final assistant `error` that is not explicitly usage-limited and has no failed native compaction recovery enters active waiting only at `agent_settled`.
- Native eligibility and waiting policy are separate; the existing public-helper parity tests remain valid even when an ineligible error waits.
- Track an unknown provider error separately from native provider retry so notifications never claim an unattempted retry was exhausted.
- Preserve the original Goal ID, active contract, persisted waiting state, and managed-run/workflow ownership; do not add a wait deadline, timer, continuation, or provider request.
- A later non-Goal input or `/goal resume` wakes the same waiting Goal; it can complete with the same ID.
- Full-run cancellation and matching automatic-compaction cancellation pause; retry-only Escape or RPC `abort_retry` keeps its approved waiting behavior.
- Preserve final recognized usage limits, failed compaction blocking, explicit `goal_blocked`, token budgets, automatic-response caps, no-progress protection, and missing-helper pauses.
- Ordinary tool-result errors are not assistant errors and do not independently enter this wait policy.
- Blank/missing error text must still wait without inventing retry eligibility or exposing unsafe provider text.
- Superseding input, replacement, clear/pause, workflow loss, session replacement, reload, and shutdown must invalidate pending error ownership and prevent stale waiting or dispatch.

## Applicable MUST Rules and Verification

| Touched area | Applicable requirements | Named verification |
| --- | --- | --- |
| Lifecycle and recovery | Own and release pending state; use the settled idle boundary; revalidate Goal/session ownership and reentrant publications; no private Pi APIs or extra retry loop. | Review of installed Pi decisions and complete diff; focused lifecycle tests; real-Pi deterministic runtime smoke. |
| Safety and waiting | No automatic request while waiting; preserve accounting, budgets, hard caps, explicit waits, cancellation, and workflow ownership. | Table-driven error/lifecycle tests; safety/budget/wait/managed-run suites; exact provider-call counts. |
| Prompt contracts and persistence | Keep tool schemas, system prompt and existing serialized prefix unchanged; append no premature inactive contract; restore/deduplicate existing state. | Cache-contract and publication tests; persistence/reload/follow-up tests; prefix and tool-result ordering review. |
| Documentation and release note | Keep README structure and warnings; describe intentional terminal-policy changes and remaining regex accurately; record changed published behavior. | Full README/settings/extension guide review; fenced-code-aware heading audit; update the existing patch Changeset; pack inspection. |
| Repository delivery | Run both required gates; stage only intended paths; preserve unrelated files and never commit HTML; update the existing PR, not a new one. | `npm run check`, `npm test`, index/diff review, push and `gh pr view` verification. |

## Plan

- [ ] Inspect authoritative installed Pi retry/compaction/settlement branches and existing Goal error tests; confirm the new wait classification and exception precedence.
- [ ] Add failing regression tests for the exact #1821 fixture, all lost #1324 sample classes, generic invalid/auth/permission errors, empty text, and native-excluded but Goal-unrecognized errors; prove settled-only waiting, same-ID wake/completion, no inactive contract, and no extra dispatch.
- [ ] Implement a distinct pending provider-error kind with no new error-text heuristic; preserve native retry/overflow classification and all safety/ownership gates.
- [ ] Cover failure paths: full cancellation before settlement; missing helpers and budgets/caps; explicit blockers/waits; queued input and superseding state; workflow loss, reload/replacement, shutdown; sanitation and exactly-once settlement.
- [ ] Extend real-Pi deterministic smoke coverage for unknown-error waiting, exact request counts, same-ID follow-up, managed ownership/cancel, and unchanged retry/compaction paths; keep the smoke code separated by a clear responsibility if needed for readability.
- [ ] Update README, lifecycle reference, and the existing Changeset; disclose that non-retryable invalid/auth errors can wait, waiting has no automatic wake, and Pi/usage-limit regex remains.
- [ ] Run focused suites and runtime smoke, both repository gates, README heading audit, Changesets status, and package pack inspection; use the supported isolated Linux environment for complete-suite evidence if macOS baseline failures recur.
- [ ] Review the complete PR and follow-up diff for correctness, security, lifecycle safety, compatibility, regressions, and scope; preserve verification limits in durable docs and PR notes, remove the completed execution plan, commit only intended paths, push, and update PR #1834 with the new contract and evidence.

## Completion Checklist

- [ ] Original #1821 waiting and same-ID completion behavior is restored without changing Pi's native false classification.
- [ ] Lost #1324 samples and other unclassified assistant errors wait without regex or extra requests; terminal-policy changes are documented.
- [ ] Cancellation, compaction failure, usage-limit, safety, budget, explicit blocker, and ownership exceptions have representative tests.
- [ ] Pending recovery cannot affect a replacement, unrelated workflow, or stopped session; waiting retains the expected managed ownership and emits one terminal outcome only after completion/cancel.
- [ ] Required checks and deterministic smokes pass, with baseline/external limitations recorded rather than hidden.
- [ ] Branch and PR contain only intended changes, no HTML, no publication, and no release dispatch; pushed commit and PR content are verified.

## Risks

Waiting does not repair the provider request or guarantee progress. A permanent error can wait indefinitely and retain managed-run ownership; external messages can wake it and cause another paid request. Recognized usage-limit policy still uses existing regex, and Pi's native classifiers still use regex. No new Goal retry text classification is permitted.

## Rollback / Recovery

No stored format or setting changes are planned. Revert the focused implementation commit to restore native-only terminal fallback; this also restores the known #1821 regression, so record that compatibility effect. Do not discard user files or rewrite published history.

## External Handoff

Live WSL2 proxy faults, physical terminal Escape behavior across Pi versions, provider cache billing, and upstream structured-error APIs remain outside deterministic local evidence. Provider/proxy owners must validate their live environments. This implementation must not claim universal structured classification, publish packages, merge the PR, create version tags, or dispatch release workflows.
