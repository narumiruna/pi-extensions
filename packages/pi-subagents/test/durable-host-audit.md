# Durable Pi host proof

The host-only tests pass for one writer and an established persistent Pi conversation. They do not prove an atomic commit across Pi and durable-worker storage, exactly-once external effects, power-loss durability, or that the main model read a report. No production behavior changes.

## Scope and verification

`durable-host.ts` has one purpose: correlate test-only admission and report receipts with a real Pi session. It imports only public root exports. `durable-host.test.ts` uses actual `SessionManager`, `AgentSession`, `AgentSessionRuntime`, inline `ExtensionAPI`, and Pi AI's synthetic provider. The outbox is a plain in-memory test value, not the durable-worker fixture.

Verified with Node `v26.11.1`, resolved `@earendil-works/pi-coding-agent@1.2.0`, and resolved `@earendil-works/pi-ai@1.2.0`. The installed coding-agent manifest requires Node `>=22.19.0`.

```text
npx vitest run packages/pi-subagents/test/durable-host.test.ts
Test Files  1 passed (1)
Tests       39 passed (39)
Duration    943ms
```

`npm exec -- tsc -p tsconfig.test.json --noEmit` reported no host-file diagnostics. At this handoff it exited 1 for two main-owned fixture/lifecycle diagnostics; this is not a passing whole-project typecheck.

All cases use the configured 5,000 ms limit. No timeout override, live provider, process, network listener, or retained user data is required. Each case disposes its sessions and removes its temporary directory. Root checks, the complete test suite, builds, and package-loading smoke are main-task verification, not results of this host-only task.

## Applicable rules

These touched-area rules were identified before implementation:

| Area | Applicable MUST requirements | Verification |
| --- | --- | --- |
| Lifecycle | Reject stale session continuations after awaits; make shutdown safe after partial initialization and repeated cleanup; release owned work. | Test actual runtime new/resume/fork/shutdown/failed startup, generation replacement, branch replacement, and replacement during publication; Review caller-owned gates and session disposal. |
| Persistence | Reconstruct branch-sensitive state from session entries; expose failures; do not treat an in-memory mutation as a disk receipt after a failed append. | Test admission replay/conflicts, report retry/conflicts, failed appends, JSONL reopen, branch/fork ownership, compaction, and truncated tails. |
| Prefix | Preserve the effective prompt, ordered active tool names, provider-visible tool declarations, and serialized existing message prefix; keep mutable receipts out of leading instructions. | Test three normalized synthetic-provider requests across ordinary turns and reopen/redispatch; Review normalization and metadata exclusion. |
| Boundaries | Use public APIs and remain independent of other extensions. | Review imports and the three new host files; no extension implementation, metadata, setting, or public feature is changed. |
| Verification | Add deterministic tests and state unverified paths. | Focused Vitest; this audit; main owns the repository gates. |

`AGENTS.md`, `docs/extension-conventions.md`, `docs/extension-settings.md`, and the durable validation plan were read completely. There are no settings or UI changes. The settings guide introduces no additional implementation requirement for this proof.

## Public API evidence

The installed package documentation was read completely for `docs/sdk.md`, `docs/extensions.md`, `docs/sessions.md`, `docs/session-format.md`, `docs/message-types.md`, `docs/compaction.md`, and `docs/custom-provider.md`. Relevant SDK examples were read completely: `06-extensions.ts`, `11-sessions.ts`, `12-full-control.ts`, and `13-session-runtime.ts`.

The following references are inside installed `node_modules/@earendil-works/pi-coding-agent/`; they were inspected, not imported privately or modified:

| Reference | Authoritative behavior |
| --- | --- |
| `dist/core/session-manager.js`: `_hasConversation`, `_persist` | A new file is not written until a user or assistant message exists. Custom entries and custom messages alone remain in memory, even when `isPersisted()` is true. File operations are synchronous writes/appends without a public fsync receipt. |
| Same file: `_appendEntry` | The entry, index, and leaf change before the file append. An append failure can leave a memory-only receipt. The bridge stops admission, discovery, and delivery after a receipt storage failure and requires a fresh host over a reopened manager; it rejects memory-only intent and report receipts from writes made outside the bridge. |
| Same file: `appendCustomEntry`, `appendCustomMessageEntry` | A non-context intent can return a stable entry ID. One custom-message entry can hold both model-facing report content and non-model-facing identity details. A separate receipt entry is not required. |
| Same file: `getBranch`, `buildSessionContext`, `appendCompaction` | Raw active-branch ancestry retains intent and report entries across compaction. Projected model context can omit the report. Receipt retention is not evidence of model consumption. |
| Same file: `branch`, `_buildIndex` | Bare navigation changes the leaf only in memory. Reopen selects the final appended entry. An appended branch checkpoint makes navigation persistent; the bridge does not add such a policy automatically. |
| Same file: `createBranchedSession`, `forkFrom` | Forks copy history but have a new session ID. Copied receipts cannot authorize the source session's work. |
| Same file: `loadEntriesFromFile` | Malformed JSONL lines are skipped. A nonempty tail gets a newline before later appends. The truncated-tail test preserves committed admission and retries one report. |
| `dist/core/agent-session.js`: `sendCustomMessage`, `_appendCustomMessage`, `_emitAgentSettled` | Custom-message delivery can append immediately, queue, or defer. A resolved promise alone is not an append acknowledgement. |
| Same file: `_bindExtensionCore` | `pi.sendMessage()` returns void and handles asynchronous errors through extension error reporting. `pi.appendEntry()` also returns void. |
| Same file: `dispose`; `dist/core/extensions/loader.js`: runtime invalidation | Actual extension actions reject after session disposal. An SDK host still must invalidate its own resources; direct disposal is not a substitute for its own shutdown policy. |
| `dist/core/agent-session-runtime.js`: `teardownCurrent`, replacement methods, `dispose` | Runtime replacement aborts outgoing work, emits `session_shutdown`, and disposes the old session before creating the replacement. Creation failure can leave the old runtime disposed. The test bridge uses the public shutdown hook to reject pending publication. |

Pi AI root exports provide `createFauxCore`, `fauxAssistantMessage`, `getCurrentSystemPrompt`, `getCurrentTools`, and `toToolDeclaration`. Their installed `dist/providers/faux.js` and transcript declarations were inspected. No private provider subpath or another extension is used.

## Delivery decision branches

The tests cover the relevant `sendCustomMessage()` branches rather than assuming that its promise is a persistence contract:

| State/options | Observed boundary |
| --- | --- |
| Idle, no trigger | Appends a custom-message entry; does not wake the model. The bridge uses this path only after checking idle state. |
| Idle, `triggerTurn: true` | Appends and performs a synthetic model request. |
| Idle, `nextTurn`, either trigger value | Resolves with no appended receipt and no request. Disposal loses the queue. `nextTurn` takes precedence over the trigger. |
| Streaming, default or explicit steering | Resolves while the receipt is absent from the session file. |
| Streaming, follow-up | Resolves while the receipt is absent from the session file. |
| Streaming, `nextTurn` | Resolves while the receipt is absent from the session file. |
| Streaming, `triggerTurn: false` | Defers append to a safe turn boundary; resolves before the receipt exists. |
| Emitting `agent_settled`, `triggerTurn: true` | Resolves inside the notification hook before its deferred append and subsequent request. This is a boundary regression, not a recommendation to start work in a notification-only hook. |

The bridge rejects new publication while busy. It does not acknowledge an outbox from a queued delivery result. It publishes report content and `reportId` together in one custom-message entry, then checks active-branch evidence and reopens the actual Pi file to verify the same entry before returning any admission or report receipt. A retry after an append-before-external-ack interruption returns that same entry ID. Concurrent retries in the same host also return one entry. Pi itself does not deduplicate matching report IDs: a negative regression produces two entries by sending the same custom message after reopen without bridge reconciliation.

## Receipt and prefix contract

An admission receipt contains `sessionId`, `requestId`, `agentId`, `runId`, and the assigned task. Reopen discovers these values without a model-supplied agent list. A repeated request returns the original session entry ID; a conflicting request fails without changing the session. A report binds to that admission entry and carries its own stable `reportId`.

Receipt queries use `getBranch()`, not `getEntries()` or compacted model context. An alternative branch cannot acknowledge a report admitted only on the abandoned branch. Forks cannot acquire work merely by copying its history. Bare branch navigation remains an explicit unsupported durable-ownership boundary until a host appends a checkpoint.

The normalized prefix test compares the effective system prompt, ordered tool declarations, ordered active names, and prior provider-visible message content. It excludes timestamps, usage, entry details, object identity, runtime implementations, and transport metadata. Admission adds no model-visible state. The first report appends at the conversation tail. Reopen and report redispatch add no duplicate content and retain the preceding request prefix.

Compaction is an intentional context transition: the test uses a deterministic summary that omits the report. Reconciliation finds the old raw receipt without reinserting the report after that transition. This is an insertion receipt contract, not a promise that a future request contains or consumes the report. Child-prefix validation belongs to the separate durable-worker proof.

## Limits and handoff

The append/ack tests inject interruption by discarding the old host and constructing fresh public session objects from JSONL. They do not kill a host process. Report/outbox values remain independent plain test data; they do not prove result-commit/report-creation ordering, durable outbox acknowledgement, or full two-store recovery. The main fixture must cover those windows and fresh-process interruption separately.

There is no public Pi transaction spanning worker storage and session storage, no durable delivery acknowledgement from `pi.sendMessage()`, and no public exactly-once external-effect contract. A single-owner bridge can reconcile a successfully appended session receipt by stable ID, but it cannot promote that evidence into a power-loss or multiwriter guarantee. No simultaneous-writer lock is implemented or proven here.

Project trust, capability checks, credential reacquisition, close semantics, external side effects, bidirectional request recovery, actual `/reload`, and full CLI compatibility remain main-task or follow-up validation. The generation guard proves the stale-generation policy; it does not claim a CLI reload smoke. No new setting, scheduler, database, or runtime feature hides these limits.

The host-only result permits continued test-only investigation under the stated insertion-receipt contract. It is not approval for production integration or a claim that the complete durable validation plan passes.
