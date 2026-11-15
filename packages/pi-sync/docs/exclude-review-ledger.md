# Exclude review ledger

Target: [PR #1903](https://github.com/narumiruna/pi-extensions/pull/1903), branch `narumi/feat/pi-sync-exclude`, reviewed head `58cb3c5a`. The checkout belongs to `narumiruna/pi-extensions`. The original complete diff and instructions are unchanged from the first implementation review. All existing GitHub check runs passed at review intake.

All pages of reviews, inline comments, issue comments, commits and review threads were fetched. There is one submitted review, three conversation comments, no inline comments, and no review threads. The two off-diff findings are in [review 5909654162](https://github.com/narumiruna/pi-extensions/pull/1903#pullrequestreview-5909654162). No Resolve API target exists for those findings.

## Applicable requirements before changes

| Area | MUST rules | Verification |
| --- | --- | --- |
| Apply preimages | Keep excluded files outside the managed scope; preserve included-file preimage checks, mutation queues and recovery evidence. Follow package `AGENTS.md` and `docs/extension-conventions.md`. | **Test:** pull, forced pull, rollback, literal/glob/case exclusions and included-file stale guards. **Review:** both `expectedFileHashes` callers and every transaction preimage consumer. |
| Manager summary | Report complete include/exclude policy state. Keep text safe and preserve lifecycle, UI modes and standard controls. Follow `docs/extension-conventions.md` and `docs/extension-settings.md`. | **Test:** non-interactive manager descriptions for exclusion-only, membership, order-only, combined and effective-session cases. **Review:** all ordering-only messages and session summary branches. |
| Documentation and checks | Keep behavior and evidence aligned. Keep the existing independent Changeset for this feature. | **Validator:** `npm run check`. **Test:** `npm test` and focused regressions. Existing runtime/pack smokes remain valid unless their boundaries change. |

## Review items

| ID | Feedback and scope | Severity | Evidence at the reviewed head | Outcome |
| --- | --- | --- | --- | --- |
| R1 | Excluded keys remain in apply preimage assertions. This breaks the new exclusion/local-field composition in pull and rollback. | P2 | `sync-mutations.ts` supplies `settings.json: null` when collection omits the file. `applySnapshot()` maps that entry without exclusion filtering. `applySnapshotTransaction()` checks every expected preimage, including paths outside the mutation plan. | Already addressed. Excluded assertion keys are filtered with the existing matcher. Eleven regressions cover pull, forced pull, rollback, glob/case variants and included-file stale guards. Pi session-root metadata resolution is unchanged. |
| R2 | The manager calls an exclusion-only difference an order difference. This hides the reason that the new policy blocks sync. | P3 | `describeManagerState()` checks only the two include-difference arrays. The remote review, direct mismatch message and attention widget already compare exclusion rules. | Already addressed. The manager checks the canonical exclusion sets. It keeps path counts for membership changes, reports combined differences, and reserves order-only text for matching exclusions. The manager regression matrix passes. |
| R3 | Codex security review failed. The summary and account-limit comment describe the same external failure, not a supplied vulnerability. | Not a code severity | [Summary](https://github.com/narumiruna/pi-extensions/pull/1903#issuecomment-6890995358) says the review could not complete. [Account-limit notice](https://github.com/narumiruna/pi-extensions/pull/1903#issuecomment-6890995649) states that the payer reached Codex usage limits. No security finding text or inline thread was supplied. | Blocked: external review only. The paying account owner must restore capacity before that service can complete a review. Do not enable paid credits or repeat the service call as part of this fix. Independent code/security checks remain required. |
| R4 | The walkthrough links PR #1902 as a possible contract conflict. | None; no active conflict | GitHub reports #1902 as CLOSED with `mergedAt: null`. Current `main` has no merge of that alternative `.syncignore` design. Its head is not part of this target. | Outdated or superseded. Do not import the closed design or change this PR's approved version boundary. No separate issue is needed. |
| R5 | The manager's Sessions label uses include membership alone. This audit finding is in the same incomplete-summary class as R2 and is exposed by whole-session exclusions. | P3 | Other new summaries use `syncSessionsSelected()`, but the manager still reads `syncIncludeSelection(config.include).sessions`. A setup excluding `sessions/**` is displayed as Sessions on. | Already addressed. The label uses `syncSessionsSelected()`. Tests cover no exclusions, whole-session literal/glob exclusions and a partial session-file exclusion. |

The completed Codex code review reports no findings. CodeRabbit's risk summary repeats R1 and R2. Its architecture assessment and title checks add no further defect. Test-generation and autofix widgets are service controls, not approved instructions. Existing feature tests cover matching, transfer, lifecycle, metadata and recovery. The added tests cover the verified defects above.

## Validation and publication

- Before the code fixes, the two new test files had 15 failures and four passes at `58cb3c5a`.
- After the fixes, all 19 tests pass. The broader local-field, manager, attention and resolution regression set passes all 379 tests.
- `npm run format` and `npm run check` pass. `npm test` passes 22,957 tests, with 18 existing conditional/platform skips and no unhandled errors.
- The complete original diff and review fix were checked for scope, security, compatibility and lifecycle safety. Only excluded preimage keys are omitted; included checks, queues, post-await guards and recovery rules remain active. No public version boundary, settings persistence policy or custom key handling changed.
- `npm run package:pack -- sync` passes and includes this ledger. A fresh RPC smoke verifies package registration, the corrected Sessions label, menu cancellation, the lazy files route and clean shutdown without a model or backend transfer.
- The existing feature Changeset still covers this unpublished PR. No package publication, tag or release workflow is part of the review fix.

This ledger travels with the review-fix commit on PR #1903. The closing PR comment records its commit and publication result. No inline review thread exists, so there is no Resolve API target. R3 remains an external service-capacity blocker, not a failed local test or a supplied vulnerability. No out-of-scope issue was created.
