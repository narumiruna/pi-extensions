# Durable Goal Host-wrapper experiment

## Outcome

**The approved Host-wrapper experiment ran, but this candidate did not pass the safety gate. Full API implementation stops.**
The original experiment used published durable and Pi AI 1.2.0 through public imports only; it changed no Pi upstream, dependency, production extension, public export, or settings file. The separately approved [runtime upgrade retest](durable-runtime-upgrade-audit.md) repeats these probes on published 1.3.0 and confirms the same failed candidate guarantees.

Public Host integration is feasible for several important cases; this is not an API-absence or universal impossibility finding.
However, the tested candidate fails provider-attempt coverage and isolation of unrelated deferred work.
The active plan requires stopping on failed guarantees, not publishing a partially bounded Goal implementation.

## Reproduce

After installing dependencies and building from the repository root:

```bash
npm run build
npx vitest run packages/pi-goal/test/durable-host-admission.test.ts packages/pi-goal/test/durable-host-lifecycle.test.ts packages/pi-goal/test/durable-host-transport.test.ts
```

The three suites contain 28 passing characterization tests.
Several assert a failed acceptance case, so green tests do not mean a passing safety gate.
Including the earlier native-only gate suites gives 40 passing focused tests.
Every test retains the normal 5,000 ms timeout.

The providers are synthetic except for a real installed Bedrock adapter connected only to a loopback HTTP responder.
That responder always returns a scripted 503 error; it never contacts AWS or uses real credentials.
The test restores its SDK infrastructure environment variables and closes the Harness and local server.
No live paid provider requests are made.

## Candidate and positive evidence

`durable-host-models.ts` intercepts chat streaming, completion, and deferred methods, awaits host admission before calling the underlying Models operation, and persists receipts before exposing terminal stream events.
It calls the underlying object directly to avoid double admission through convenience-method delegation.
Cancellation remains available after spend denial.
This is a repository-only prototype, not a production-safe implementation of the entire `Models` interface.

`durable-host-ledger.ts` uses native conversation documents and host transactions for reservations and usage.
It binds public hook task/conversation IDs to request signals, validates the persisted `ProviderDoc` session ID and public task checkpoint, and stores deferred-handle authority before publishing it.
The tests prove:

- A provider sees a persisted reservation before dispatch; response/token exhaustion denies subsequent native model requests and wrapped substantive tools.
- One outstanding reservation prevents simultaneous generation/compaction dispatch from causing a second token-budget overshoot; the competing operation is rejected rather than queued.
- Usage is committed before a terminal event resolves `stream.result()`.
- Passive JSONL reopen schedules no work; uncertain in-flight or failed-receipt work is not blindly resent.
- Current activation and fork checks reject stale authority; ordinary unrelated non-deferred input stays usable.
- Deferred-handle recovery can work without a new `beforeRequest` callback, and explicit native cancellation still reaches the provider after poll admission is denied.
- Execute-time tool wrappers can reject nested calls after an await and replay-safe calls after reopen, even when native recovery skips `beforeTool`.

`durable-host-lifecycle.test.ts` separately proves a public foreground sibling reconciler can await supervisor receipts and commit identity-checked canonical state after fault, source abort, and explicit orphaning.
It tests owned-tree drain, final native usage publication, unrelated-task isolation, newer-activation and accepted-terminal-state preservation, and interrupted reconciliation followed by passive reopen and explicit recovery.
It also demonstrates a task-scoped Models facade for subordinate calls using the public tool API.
These are supporting prototypes, not one integrated Goal implementation.

## Failed acceptance cases

### Models admission is not a complete SDK-attempt boundary

`durable-host-transport.test.ts` runs a real Harness with native retries and compaction disabled.
The Host wrapper persists exactly one admission and one receipt, and forwards `maxRetries: 0`.
With the AWS SDK's test-scoped attempt setting at two, the loopback server nevertheless receives two HTTP requests.
The injected public `fetch` function receives zero calls.

The installed `@earendil-works/pi-ai/dist/api/bedrock-converse-stream.js` constructs `BedrockRuntimeClient` without translating the per-request `maxRetries` option to SDK `maxAttempts` and uses its SDK request handler rather than the injected fetch function.
Therefore the tested generic Models boundary neither disables nor individually admits those SDK attempts.
This does not show requests after known token exhaustion; it specifically disproves the required disabled-or-individually-guarded SDK retry guarantee for this candidate.

A reviewed provider/transport restriction or another supported dispatch boundary might address this, but no such complete supported profile is implemented or validated here.
The experiment does not silently reduce provider coverage, alter process-wide retry policy in production, or claim `maxRetries: 0` is universally sufficient.

### Goal-only deferred routing affects unrelated work

The admission suite includes an ordinary deferred request in another ownerless conversation sharing the Harness and guarded Models.
Its initial request starts, but its poll is rejected as `Unknown deferred handle` by the candidate's Goal-only receipt router.
The submission becomes unanswered, with zero underlying deferred fetches.
Native failure alone also leaves the remote synthetic handle uncancelled; the test explicitly cleans it up.

This is a failed isolation case, not successful denial of unauthorized Goal work.
Blindly allowing unknown handles is not a demonstrated fix: it would abandon the trusted attribution requirement.
A durable routing design for both Goal and unrelated handles, including recovery and collision handling, remains unimplemented and unproved.

## Original experiment verification and review

- `npm install`: completed with no manifest or lockfile changes; npm still reports three high-severity dependency advisories outside this experiment's scope.
- Focused native and Host suites: 40 tests passed, including 28 new Host probes.
- `npm run check`: passed builds, Biome, package boundaries, and all workspace typechecks.
- `npm test`: 11,112 passed, two skipped across 669 active-suite files.
- Goal package build and `npm run package:pack -- goal`: passed; the 37-file dry-run inventory excludes all repository-only prototypes, tests, audit notes, and the root plan.
- Reviewed the full experiment for correctness, security, cancellation/disposal, storage ordering, compatibility, regressions, and scope against `docs/extension-conventions.md`, `docs/extension-settings.md`, and package instructions. Independent review found one cleanup-failure issue; both new fixture suites now attempt every close/removal and report aggregate failures. Focused and full checks were rerun after the fix.

No production runtime loading or metadata changed, so no new package-directory/lazy-menu smoke or Changeset is required for this experiment. Packed durable consumers and the end-to-end Goal host smoke cannot run because the gated public API does not exist; these plan requirements remain incomplete. No version tags, publications, or release workflows were created.

## Stop and remaining requirements

The wrapper experiment was explicitly approved and actually attempted; it is not waiting for the same approval again.
Per the plan, retain the candidate only as diagnostic test evidence and stop full API implementation.
Do not change Pi upstream, patch installed dependencies, or weaken the failed requirements.

Still unproved are the complete provider/profile matrix, all dispatch surfaces, recovered compaction attribution and ambiguity, complete retry/partial-usage deduplication, no-progress parity, live-profile cleanup, and integrated Host control/ownership/accounting behavior.
The prototypes do not enforce arbitrary tool-internal effects after awaits; each owning implementation still needs cancellation and stale-state checks.
Close/reopen tests use orderly cancellation at selected commit boundaries, not an OS kill, torn JSONL, or physical disk failure.
Missing definitions become orphan receipts only after an explicit public abort request; passive observation does not orphan or resume them.

The public API, package exports/types, native lifecycle tools, external waits, contracts, packed durable consumers, and end-to-end host example remain unimplemented.
No Changeset or new runtime-loading smoke is needed for these repository-only prototypes and tests.
