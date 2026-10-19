# Native durable Plan Mode

> **Experimental.** The `/durable` API supports the tested durable release only. It does not replace the coding-agent extension or provide its complete interface.

`@narumitw/pi-plan-mode/durable` provides a native, headless planning workflow. The host owns the Harness, credentials, registry, environment, authorization, storage, and human interface. A model can ask questions and submit a proposal. Only a host controller operation can authorize implementation.

## Compatibility and release evidence

The supported runtime is `@earendil-works/pi-durable` 1.2.0 with `@earendil-works/chord` 1.2.0. These are the repository's pinned, published dependencies, not the newer local Pi checkout. Other releases are unverified. The durable import graph has no coding-agent, TUI, Kit, settings-file, or session-decoding dependency. The existing `pi.extensions` entry, explicit and extensionless source/dist imports, and `package`/`package.json` metadata aliases remain available.

The release-contract fixtures use a real Harness with synthetic providers and no paid calls:

| Contract | Public API and observed behavior | Verification |
| --- | --- | --- |
| Workflow history | `defineDoc({ history: "rewindable", fork: "asOf" })`, public commits and snapshots preserve historical state. Native fork copying does not revoke authorization; the integration checks the owning conversation. | `durable-release-state.test.ts` |
| Passive inspection | `Harness.inspect()`, snapshots, and observers do not start recovered work. Explicit resume, submit, and progress waits can start it. | `durable-release-state.test.ts` |
| Persisted questions and plans | A tool commits state through `ToolExecutionApi.commit()` before returning `control: { terminate: true }`. The invocation does not wait for a person. | `durable-release-state.test.ts` |
| Admission and recovery | `hook(ToolTask, { beforeTool })` covers direct and nested admission. Recovered replay-safe execution does not rerun this hook. Execution wrappers must revalidate permission. | `durable-release-recovery.test.ts` |
| Input delivery | `Conversation.submit()` applies native busy admission and conversation-scoped `requestId` deduplication. Deduplication does not compare content. The integration also checks the exact placed input and its workflow marker. | `durable-release-state.test.ts`, `durable-controller.test.ts` |
| Handoff boundary | A conversation-owned `background: true` task can await idle without waiting for itself. An idle wait is not an exclusive admission lease; public commits recheck state and native input submission rejects a competing run. | `durable-release-handoff.test.ts`, `durable-controller.test.ts` |
| Persisted model contract | Native `section()` preparation appends `pi.system` changes before the request cutoff. After compaction, native preparation publishes one active baseline. A `beforeRequest` message replacement would be request-local and is not used. | `durable-release-handoff.test.ts`, `durable-policy.test.ts` |

`HookApi` supplies document reads and task memos, not arbitrary writes or task control. The integration does not cast it to `TaskRuntime`, import private admission helpers, create raw submission records, or append model messages to bypass native busy admission.

## Host setup

Install this package and the supported durable and Chord host dependencies. Build a local checkout before importing its generated JavaScript.

```typescript
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createDurablePlanMode } from "@narumitw/pi-plan-mode/durable";

const registry = createRegistry();
// Install and review host tools and wrappers before opening the Harness.
const planMode = createDurablePlanMode({
  registry,
  registryVersion: "reviewed-host-v1",
  capabilities: [], // Add only capabilities whose effective implementations you reviewed.
});
registry.install(planMode.extension);
const harness = await Harness.open(new MemoryStorage(), {
  models: createModels(), // The host supplies its provider catalog and credentials.
  registry: planMode.registry, // Required: do not pass the unguarded registry.
}, context);
const controller = planMode.createController(harness);
// Bind the controller before resume() or any call that starts recovered tasks.
const conversation = await harness.root(context);
const current = await controller.inspect(conversation, context);
await controller.start(conversation, {
  operationId: "start-1",
  workflowId: "workflow-1",
  expected: { workflowId: current.workflowId, revision: current.revision },
}, context);
// Submit planning input after selecting a model. Inspect pending questions/plans through the controller.
```

Construction, binding, and inspection do not start execution. Starting with a prompt, answering, revising, approving, discarding, and explicit reconciliation can start a native delivery task. The returned view can still report a pending delivery; it is not a promise that input placement or implementation has completed. Read the operation receipt, wait for its `taskId` through the host Harness, and inspect again. If needed, use its `submissionId` to wait for the model run.

The complete [synthetic host example](./durable-example.mjs) exercises proposal and explicit approval without a live provider:

```bash
node packages/pi-plan-mode/docs/durable-example.mjs
```

## Controller contract

Conversation IDs are resolved within the controller's bound Harness; methods never mutate a foreign handle's storage. Every mutation takes a conversation, input, and Chord `Context`. It requires a bounded `operationId` and `expected: { workflowId, revision }`. Inspect the current view before a new mutation. Keep the original input when retrying an operation.

| Operation | Required state and result |
| --- | --- |
| `inspect(conversation, context)` | Read a detached view without resuming work. |
| `start(conversation, input, context)` | Activate a new workflow identity from inactive or implementing state, or explicitly activate a fork. Activation rejects while ordinary foreground work is live, so an already-running Normal mutation cannot cross into Plan mode. An optional `prompt` starts planning input delivery. |
| `answer(conversation, input, context)` | Match the pending `batchId` and every question; persist validated answers and deliver them once as new input. |
| `cancelQuestion(conversation, input, context)` | Clear a pending batch without inventing or submitting an answer. |
| `revise(conversation, input, context)` | Invalidate a ready plan immediately and deliver bounded revision feedback. |
| `approve(conversation, input, context)` | Freeze the exact ready revision and persist an implementation handoff intent. There is no model-callable approval tool. |
| `discard(conversation, input, context)` | Revoke the workflow, clear its question/plan/approval, and keep guards restrictive until outstanding work drains. |
| `reconcile(conversation, context)` | Explicitly resume or reconcile the same pending logical delivery. It does not create a replacement request ID for failed input. |
| `dispose(context)` | Stop and join controller transition tasks without stopping unrelated tasks or removing execution guards. |

Controller commits and native delivery admission are serialized per conversation within one bound Harness. Idle waits and task joins stay outside that critical region. This does not reserve admission against independent host prompts; execution guards still check the exact approved run.

Discard persists a verified queued-input withdrawal intent with its state transition. Native cleanup and receipt reconciliation can therefore resume after a crash, including a lost acknowledgment after withdrawal. A never-placed delivery is marked failed; an already-placed exact delivery retains a done receipt and its submission ID rather than being reported as withdrawn.

An identical retained operation ID and payload is a no-op. Optional object fields set to `undefined` are treated as absent for operation identity; explicit `undefined` array elements are rejected. A conflicting payload is rejected. Every new mutation advances the revision, so a concurrent approval/revision cannot both use the same ready revision. Receipt history retains at most 32 operations; an older retry no longer present in that history fails its stale revision instead of repeating an effect.

Questions contain 1–3 items with 2–4 options each. IDs are at most 128 characters, headers 12, question text and option descriptions 1,000, and option labels 128. Answers and notes are at most 4,000 JavaScript characters each. Plans must be nonblank and at most 50,000 JavaScript characters; their accepted text is not truncated or normalized. Helper output is a bounded acknowledgment, not a second copy of the plan. Question/answer serialized output is bounded to 50 KiB and 2,000 lines. Invalid data is rejected before publication.

## Ownership and state

The versioned conversation document stores the owning conversation, workflow identity, revision, frozen capability policy, one question batch, one ready plan, and bounded receipts. Its phases are `inactive`, `planning`, `awaiting_answers`, `ready`, `handoff_pending`, and `implementing`.

Reopening the same conversation preserves the workflow. A fork retains a historical plan for review but its view masks live questions, approval, delivery, and receipts. The fork must start explicitly with a new identity before it can continue. Merely attaching a view cannot authorize or start work.

Question and completion helpers are model-only: nested results do not propagate termination controls. Both definitions remain stable in all phases. Completion records a proposal, never approval. Mixed parallel tool batches have best-effort termination; a termination hint does not cancel sibling calls. Stale helpers and calls outside the effective workflow are rejected independently.

## Permissions and registry review

Always pass `planMode.registry` to the Harness. The returned reader guards effective tool execution, including tool replacements and wrapper results, independently of whether the model sees a tool or the policy extension remains selected. It also adds tool-name-scoped native `ToolTask` admission hooks to tool-owning extensions, preserving their existing hooks. Fresh calls therefore receive durable authorization even after the host deselects the Plan extension following a completed discard. Execution guards repeat the checks on recovery. Native recovery of an admitted call skips admission hooks, so missing or stale authorization still fails.

`registryVersion` identifies the host's review of the complete immutable registry, including overrides, wrappers, orchestration, and replay behavior. Install everything before the Harness first reads the registry. A later registry publication fails closed; restart with a newly reviewed version instead of modifying the graph under an active workflow. Reusing a version for different code across a restart violates the host contract. Installed registrations and their function objects must remain immutable; changing them in place without publishing a new registry snapshot is also outside this contract. An active workflow frozen under a different version cannot gain permission by reopening it; close it explicitly before starting a new one.

Pi resolves tool wrappers and calls `prepareArguments()` before `beforeTool`. Every registered wrapper and argument preparer, including those on blocked tools, must obey Pi's pure-function contract: no external effects, task creation, document mutation, or input mutation. The host must review this code as part of the complete registry. Execution guards do not sandbox module initialization, registry resolution, schema callbacks, earlier host hooks, environment construction, arbitrary host tasks, or an impure preparer. `durable-preparation.test.ts` preserves supported pure repair behavior and explicitly characterizes this unsupported impure-preparer case for direct and nested calls.

`capabilities` is an explicit list of `{ name, policy }`, where policy is `read-only`, `bash`, or `powershell`. No tools are admitted by default. Names and server annotations are not proof of read-only behavior. Review the effective implementation and every wrapper before granting a capability. A reviewed orchestrator does not authorize its nested callees. Core `edit`, `write`, `update_plan`, and the helper names cannot be added as planning capabilities.

Limited shell policies reduce risk; they are not an OS sandbox, filesystem boundary, or confidentiality guarantee. Reviewed read-only tools can still expose data, and permitted tests can execute project-defined code or create caches. Use a trusted environment and independently review tools that create tasks, mutate documents, or call external systems. The host must not bypass the guarded registry or alter workflow documents to grant authorization.

During handoff, restrictive policy remains effective until a placed, exact, workflow-marked kickoff belongs to the approved run. A concurrent unrelated prompt cannot use an approval receipt to execute a mutation. Receipt reconciliation checks native placement and exact content, not admission alone. A crash after submission but before receipt storage reuses the same native request ID.

## Model context

Static native Plan/Normal sections contain no mutable counters, workflow IDs, questions, or revisions. Native generation preparation persists section changes at mode transitions and keeps tool definitions stable on ordinary turns. These are intentional prefix transitions, not a cache-hit guarantee.

Compaction starts a new prefix epoch. The native preparation path publishes one active canonical section/tool baseline after the retained transcript. Pi can normalize that baseline to the leading system position when only user messages precede it, as required for provider prompt/tool semantics. Ordinary requests after that boundary preserve the normalized prefix. No moving `beforeRequest` injection restores contracts.

## Recovery and disposal

Use a durable storage adapter for restarts; `MemoryStorage` is only a demonstration. One process owns a storage. Do not share an open storage between hosts. A storage failure ends the Harness; reopen the same ledger and bind a compatible integration before explicitly resuming.

Cancellation of a Chord wait does not withdraw admitted input. Queued input can be withdrawn through the native submission API; already-placed input cannot be described as withdrawn. A failed handoff retains the ready plan, intent, and receipt for inspection and explicit reconciliation or discard. Do not create a new request ID merely because the caller did not receive an acknowledgment.

Controller disposal aborts and joins its native transition tasks, but it does not remove policy guards or cancel unrelated host work. Close or discard the workflow before removing the adapter. If shutdown interrupts a transition, reopen the ledger and explicitly reconcile its retained intent. Unsupported document versions are rejected without overwriting them. Views and watchers are presentation resources, not the workflow ledger. Treat returned plan, question, and answer text as untrusted UI input; sanitize terminal controls when displaying it without changing the persisted payload.

## Deliberate scope limits

This entry does not provide fresh-conversation implementation, saved-plan catalogs, Markdown export, custom TUI, model selectors, automatic finalization retries, or settings-file integration. Those coding-agent capabilities remain unchanged. Durable mode adds no environment variables and does not load user or project coding-agent settings.
