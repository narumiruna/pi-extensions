# Durable Goal runtime safety gate

## Result

**Blocked. Do not implement or export the durable Goal API on this evidence.**
The repository pins `@earendil-works/pi-durable` and `@earendil-works/pi-ai` to `1.2.0` in root `devDependencies`.
The real-Harness probes use those installed releases, not the newer upstream checkout or a simulated Harness.
Passing characterization tests demonstrate runtime behavior; they do not establish Goal safety compliance.

The required native fail-closed request boundary is absent from the inspected public extension API.
A supervisor can reconcile a settled submission, but an internal tool loop can already have sent more provider requests before settlement.
The plan requires stopping here rather than replacing finite limits with notification hooks, observer callbacks, or private runtime casts.

## Reproduce

Run from the repository root after `npm install`:

```bash
npm run build
npx vitest run packages/pi-goal/test/durable-safety-gate.test.ts packages/pi-goal/test/durable-recovery-gate.test.ts
```

The probes make no network requests and have finite synthetic response scripts.
Persistent reopen probes use temporary JSONL stores; cleanup closes every Harness before deleting its store.
Every test uses the repository's normal 5,000 ms limit.

## Observed behavior

| Probe | Evidence | Consequence |
| --- | --- | --- |
| Throwing `beforeRequest`, `afterResponse`, or `afterTools` | All three synthetic model responses and both tool effects still occur; errors reach `onReport`. | Throwing is not a stop boundary. |
| Blocking `beforeTool` | The tool effect is prevented, but a second provider request still occurs. | Tool denial alone cannot enforce a response or token limit. |
| Task memo updates and successor generation | A second write to the same memo returns its first value; the next generation has a different task ID and its own memo. | Memos are not a mutable cumulative Goal ledger. |
| Deferred provider response | Three deferred fetches occur with one `beforeRequest` invocation. | Generation hooks do not guard every provider operation. |
| Manual compaction with a throwing selection hook | Summarization still calls the provider, publishes a summary, and invokes no generation request hook. | Compaction needs a separate admission boundary. |
| Persistent submission replay | Reopening and submitting the same request ID returns the original settled submission without another provider call. | Native logical-submission deduplication is available. |
| Interrupted replay-safe tool | Read-only reopen stays quiet; explicit recovery executes the tool again without rerunning `beforeTool`, even after its policy changes to deny. | Recovered handlers or supported wrappers need their own execution-time guard. |
| Source cancellation | Cancels a task-owned execution conversation and its provider request without cancelling another conversation's foreground task. | Ordinary ownership propagation is available. |
| Custom supervisor fault | Task becomes `faulted`; its abort handler does not run; its custom active-state document remains active. | A separate persisted terminal-receipt reconciliation path must be proved. |

These fixtures do not implement Goal completion, waits, host controls, or a production accounting ledger.
The recovery probe intentionally changes only the hook policy; it does not claim that a correctly guarded tool implementation is unsafe.

## Public API and request-path audit

The following paths are relative to `node_modules/@earendil-works/pi-durable/` and refer to the installed release.
No test imports an internal module.

- `dist/harness/types.d.ts`: `HookApi` permits committed document reads, model access, identifiers, and task memos, not authoritative document commits or cancellation. `GenerationHooks.beforeRequest` returns replacement messages only; `afterResponse` and `afterTools` are notifications. `onYield` can continue a final answer, not stop an already admitted tool loop.
- `dist/harness/scheduler.js`: the hook runner reports and skips ordinary hook errors. Task memos are write-once per key and scoped to the asking task. Fault termination does not invoke the custom task's abort handler.
- `dist/harness/registry.js`: built-in generation, tool, and compaction task definitions cannot be replaced through normal extension registration. Extension wrappers cover tools and prompt sections, not provider dispatch.
- `dist/harness/generation.js`: initial and recovered request phases call `beforeRequest`; durable transient retries return through that phase. Tool-round successors are admitted unless termination, reset, or handoff ends the run. Deferred polling calls `models.fetchDeferred()` directly, and pending results return before `afterResponse`.
- `dist/harness/tool.js`: `beforeTool` can block an initial model or nested call, but an interrupted replay-safe tool resumes directly in execution without that hook. A blocked result does not terminate the enclosing run. Nested tool controls do not apply to the parent round.
- `dist/harness/compaction.js`: blocking threshold compaction can start before generation's request hook; overflow recovery can also start compaction. Compaction requests and retries call `models.completeSimple()` without generation hooks. `beforeCompact` is a selection-time decision and is not rerun on a summarization retry. Declining a threshold compaction does not prevent the generation request.
- `dist/harness/agent.js` and `dist/harness/compaction.js`: the default background-compaction policy creates conversation-owned background tasks. Requiring the host's `settings.compaction.backgroundTokens` to remain `0` is necessary for the proposed cancellation profile, but does not solve blocking/overflow request admission.
- `dist/harness/live.js`: scheduler-owned terminal cleanup handles built-in task kinds, not the custom Goal record. A native persisted reconciliation mechanism remains unproved.
- `dist/harness/usage.js` and generation/compaction usage writes: committed assistant entries and model usage are available, including tool-loop responses and applicable failed attempts. Compaction adds model usage directly, not through an assistant entry. `UsageDoc` aggregates generation and compaction by model, separates tool usage, and starts fresh on a fork; it is not the cumulative Goal response/no-progress ledger.

There is also a separate retry layer: `ConversationStreamOptions.maxRetries` controls provider/SDK retries inside a durable request attempt.
A future supported design must define its spend boundary and prevent hidden transport retries from invalidating the promised admission limit.
The current probes cover ordinary durable retries, not physical HTTP retries inside real provider SDKs.

## Decision required

Choose a separately reviewed path before resuming implementation:

1. Add or adopt a supported runtime API that can deny requests and tools before dispatch, with authoritative accounting and recovery semantics.
2. Explicitly approve a host-owned `Models`/provider admission wrapper and its expanded host contract, then prove it against the same limits and recovery cases.

The second option is possible through public host APIs, but is not a guarantee provided by installing a native extension.
It needs persistent atomic admission, Goal attribution, concurrent/recovered request handling, and coverage for streaming, completion, deferred polling, compaction, and provider/SDK retries.
Deferred polling currently forwards only a cancellation signal, not a Goal/conversation identifier, so attribution cannot be assumed.
Cancellation of already admitted deferred work must remain available after new spend is denied.
Neither option is implemented or implicitly approved by these fixtures.

## Verification results

- `npm install`: completed without manifest or lockfile changes; npm reported three high-severity dependency advisories, which this test-only work does not resolve.
- Focused Vitest run: 12 characterization tests passed.
- `npm run check`: passed builds, Biome, package boundaries, and workspace typechecks.
- `npm test`: 11,084 tests passed and two skipped across the complete active suite.
- `npm --workspace @narumitw/pi-goal run build`: passed.
- `npm run package:pack -- goal`: passed; the dry-run inventory contains 37 existing package files and excludes these repository-only tests, audit, and root plan.
- Semantic review: checked public-only imports, bounded synthetic scripts, cancellation, disposal, persistent reopen, temporary-store cleanup, compatibility, and scope against `docs/extension-conventions.md`, `docs/extension-settings.md`, and package instructions; an independent read-only review found no actionable defects.

No new public runtime or metadata exists to exercise with packed durable consumers or a durable host smoke.
The interactive package-directory/lazy-menu smoke was not run because runtime loading is unchanged and this work stops at the required gate; the existing compatibility suites ran in the complete test suite.
No live or paid provider requests, package publication, version tags, or release workflows were used.

## Unverified requirements

The plan remains incomplete and must be retained.
The supported host profile and live-profile rejection, cumulative budgets, no-progress limits, terminal-receipt reconciliation, new-tree resume, forks, waits, native terminal tools, context contracts, optional public build/exports, packed durable consumers, and the end-to-end host example remain unimplemented and unverified.
No public package behavior, settings file, runtime dependency, or release metadata changes in this safety-gate work.
A Changeset and runtime-loading smoke are not required for these repository-only tests and audit notes.
