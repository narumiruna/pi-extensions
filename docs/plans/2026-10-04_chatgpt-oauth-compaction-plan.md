# Verify ChatGPT OAuth Context Management

Status: the authorized live compaction/replay probe is complete. The previously missing repository gate now passes; the original result-acknowledgement requirement remains open. No further hosted request, credential operation, or publication is authorized by this cleanup.

## Goal

Retain the result and close acknowledgement of the October 5, 2026 probe: whether the tested official OpenAI ChatGPT OAuth credential could complete remote compaction and checkpoint replay through the experimental `context-management` protocol. The tested Pi release and model are historical evidence, not a current support guarantee.

## Context

Issue #1421 reports `hardened_oauth_rule_missing` / `rejected_by_hardened_oauth_boundary` during remote compaction with official ChatGPT OAuth. Merged PR #1426 adds diagnostic guidance and native fallback; merged PR #1430 adds explicit opt-in streaming Context Management. Both implementations are present in this checkout.

A live probe using installed Pi 1.0.2, the stored `openai` OAuth credential, `gpt-6.1-sol`, and synthetic conversation history made exactly one `POST https://api.openai.com/v1/responses/compact` request. It returned HTTP 401 with the reported code/type pair. The credential file remained unchanged and temporary files were removed. This confirms the unary rejection for that credential/model at the time of the probe, not a universal OAuth restriction.

The current interactive session uses `openai-codex/gpt-6.1-sol`; that is a distinct provider route. This plan tests the official `openai` route implicated by the issue, not the Codex route.

In a disposable repository copy at commit `6b1644d5`, all 262 `pi-codex-compact` tests passed with Node 26.10.0 and Pi dependencies 1.0.2. These deterministic results verify request handling and fallback, not hosted entitlement. Context Management was untested at that stage; the resumed results below supersede that initial limitation.

The user approved end-to-end execution, including at most two hosted requests, a focused branch, signed commit, push, and pull request in the subsequent instruction naming this plan. No publication or issue metadata changes are authorized.

The user subsequently selected option 1, explicitly authorizing Pi's normal refresh of the stored official `openai` OAuth credential before resuming the same at-most-two-model-request probe. This supersedes the no-refresh restriction below only for Pi-managed OpenAI OAuth refresh; it does not authorize interactive re-login, Codex token substitution, alternate routes, or additional model requests. PR #1440 has merged; resumed work uses a focused follow-up branch from the current `origin/main`.

## Plan

- [x] Obtain approval for at most two hosted requests and their quota exposure; record approval before making either request. Evidence: the user's end-to-end execution instruction naming this plan.
- [x] Inspect the working tree and installed APIs. Evidence: `origin/main` and HEAD both resolved to `6b1644d5`; created `narumi/docs/verify-chatgpt-compaction`. Reviewed the collector, request implementation, replay tests, and installed credential APIs; copied package source into an isolated temporary directory. Hosted fixture preparation was not applicable after credential preflight failed; no conversation content was sent.
- [x] Resolve a currently valid stored official `openai` OAuth credential without refresh or writes, or stop at the named blocker. Evidence: October 5, 2026 preflight found an expired stored OAuth credential. A hash-bracketed read-only check confirmed expiration and unchanged credential-file content during that check. No refresh, re-login, or key command was run.
- [x] Resume credential resolution through Pi's public `ModelRuntime.getAuth()` API with the normal file-backed store. Evidence: request auth resolved as OAuth, the official OpenAI credential was valid, and all credential data remained unchanged during this process; zero OAuth refresh requests were necessary.
- [x] Make one bounded `context-management` request with synthetic history and an assistant-only fact. Evidence: 36,505 serialized input characters, one HTTP 200 from streaming `/v1/responses`, and one checkpoint item accepted by the existing collector and bounded replacement-history validator; retries disabled.
- [x] Only after validated compaction succeeds, make one ordinary replay request using checkpoint history without original plaintext. Evidence: one HTTP 200 through the same provider/model, with exact recovery of the assistant-only synthetic passphrase. Dispatch and payload assertions verified exactly two model requests and absent original plaintext.
- [x] Clean up the original stopped execution's temporary files and inspect its diff. Evidence: that temporary directory was removed; no request, timer, listener, or session was created during that stopped execution. Manifests and lockfile remained unchanged after dependency setup. Resumed cleanup is recorded in Completion Checklist below.
- [x] Report observations separately from historical PR claims without changing runtime behavior. Evidence: `docs/implementation-notes/chatgpt-oauth-compaction-verification.md` records the prior unary 401, original expired-credential blocker, successful resumed streaming compaction and replay, historical PR limits, existing opt-in guidance, quota exposure, and checkpoint-disable warning.

## Scope and Verification Rules

No executable behavior changes are planned, so no new regression tests, Changeset, or release are required for this documentation-only probe. Before completing any repository change under this plan, run both `npm run check` and `npm test` separately from the repository root and record passing results; a blocked live probe does not waive either gate. If evidence suggests a code change, stop and obtain approval for a revised implementation plan before editing.

Apply `docs/extension-conventions.md` lifecycle and verification requirements to the probe: release owned asynchronous resources and avoid stale continuations (`Review` of cancellation/cleanup; bounded live `Smoke`). Review the existing protocol's strict checkpoint validation and stateless replay contract rather than bypassing it. No persistent settings writes or custom UI are in scope.

## Risks

The two requests may consume subscription quota; successful inference may still return no checkpoint. Hosted support can vary by account, model, grant, or date. A successful synthetic replay does not establish compatibility for all real sessions, cache performance, Azure, Codex, or custom providers. Unknown future error shapes must not be treated as proof of the reported authorization failure.

## Rollback / Recovery

Use disposable probe files and Pi's public credential store; never publish credentials or copy them into the repository. The original execution prohibited refresh; the resumed execution permits only the user-approved Pi-managed official OpenAI OAuth refresh. Refresh can rotate tokens: preserve Pi's successfully published credential and never restore an old token snapshot. No persistent configuration or session changes should need rollback. If other provider credentials change concurrently, report that observation without overwriting them. Do not disable the extension in sessions containing opaque checkpoints, because disabling also stops checkpoint replay.

## Verification Evidence

- Focused suite: 262 tests in 16 files passed after rebuilding `pi-tui-kit`.
- `npm run check`: builds, Biome, package boundaries, and all workspace typechecks passed.
- Full `VITEST_MAX_WORKERS=2 npm test`: 6,039 tests in 476 files passed with the unchanged five-second test cap.
- No executable changes, metadata changes, or release actions; no new regression test or Changeset is applicable.

### Review-fix verification

The verification counts above describe the initial execution, not a passing review-fix test run. R1 identified the scope rule's incorrect waiver of repository gates; it now requires both gates for every repository change, including when hosted testing is blocked.

- `npm run check` passed after the rule correction; a complete-diff audit found no other gate waiver in this pull request.
- The two-worker full `npm test` retry did not finish within the 300-second command deadline and reported failures in unchanged tests. A focused single-worker run of the seven reported files passed 53 tests and failed one `pi-sync` root-storage test at its unchanged 5,000 ms timeout.
- A single-worker full `npm test` retry was terminated at its owned 600-second subprocess deadline, with no final suite result. It reported timeouts in `pi-sync` Git backend/routes tests and the `pi-chrome-devtools` generated-entry test. No test timeout was increased, unrelated code was changed, or hosted request was made. The cause of these failures remains unverified; the passing root-test gate required for this revision remains blocked.

### Resumed live verification

On October 5, 2026, the probe resumed on `narumi/docs/verify-refreshed-chatgpt-compaction` from `46a05a29` after #1440 merged. Compaction and ordinary checkpoint replay both returned HTTP 200 with Pi 1.0.2, official OpenAI OAuth, and `gpt-6.1-sol`. One validated opaque checkpoint recovered an assistant-only synthetic fact without the original plaintext. The stored token was valid at resolution time, so the approved refresh did not need to run. Exactly two model requests and zero refresh requests were sent; credential data and persistent settings remained unchanged, and temporary files were removed. For this follow-up, `npm run check` passed and all 262 package tests passed. A two-worker full `npm test` run reached the 300-second command deadline without a final result. It reported failures in unchanged `pi-sync` root-storage, Git backend/routes, and settings-management tests, plus `pi-goal` and `pi-statusline` generated-entry tests. Several were 5,000 ms timeouts; the concurrent-settings failure's cause is unverified. No per-test cap was increased or unrelated source changed. At that checkpoint the required passing full-suite result was missing; the later Cleanup verification below supersedes that repository-gate blocker.

## Cleanup verification

At repository baseline `01525ffe`, sequential `npm run check` and full `npm test` passed: 947 files, 21,379 tests, 34 skips, and no unhandled errors. This clears the current repository-gate blocker; it does not change the historical failed runs above or revalidate hosted entitlement. The probe outcome and all unverified provider/account paths remain in `docs/implementation-notes/chatgpt-oauth-compaction-verification.md`.

## External Handoff

The user owns the remaining result acknowledgement named by the original completion criterion. Review the retained evidence note and record acknowledgement or a concrete remaining concern. Expected result: a documented disposition of the observed streaming success and separate unary rejection, without a general entitlement claim. Other accounts/models, real-session recall, alternate provider routes, and cache performance remain unverified; no new hosted test is needed or authorized merely to close this plan. Publication remains outside scope.

## Completion Checklist

- [x] Explicit approval for the hosted probe is recorded in Context and the first Plan task.
- [x] Actual Pi version, model, provider, endpoint, request counts, and sanitized HTTP results are recorded in the evidence note, separating initial unary rejection, blocked preflight, and successful resumed streaming requests.
- [x] A validated Context Management checkpoint and exact synthetic fact recovery were observed with original plaintext omitted. Prior blockers remain historical observations, not current blockers or evidence of protocol failure.
- [x] The resumed probe dispatches at most two model requests: exactly two streaming Responses requests, zero OAuth refresh requests, and no retries or alternate routes. The original blocked execution dispatched zero.
- [x] Remove all resumed temporary resources and preserve unrelated changes. Evidence: probe `finally` aborted controllers, cleared deadlines and listeners, restored the fetch wrapper, deleted the temporary directory, and confirmed all credential data was unchanged during the resumed process.
- [x] Both required repository gates have current passing evidence. See Cleanup verification for the complete unfiltered run; historical follow-up failures remain recorded above.
- [ ] The handoff names applicable guidance, the successful live smoke, verification results, risks, and unverified paths; the user accepts the observed result. The expired-credential blocker was superseded by the authorized resumed test, not accepted as proof of protocol failure.

Delete this plan only after the remaining result acknowledgement is recorded, preserve the evidence note, and report the former plan path. Do not repeat hosted requests to obtain acknowledgement.
