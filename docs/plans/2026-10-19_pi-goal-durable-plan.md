# Goal: native durable integration

## Goal

Add an opt-in `@narumitw/pi-goal/durable` API for one persistent objective with explicit completion, blocking, external waits, finite automatic work, and host-controlled pause/resume. Preserve the existing coding-agent `/goal` extension and its safety behavior.

Build a native durable workflow, not an `ExtensionAPI` adapter or an unbounded copy of the reviewer example.

## Context

- `packages/pi-goal/README.md` and `src/tools.ts` define current completion, blocker, wait, token-budget, and stale-goal behavior.
- `src/safety.ts`, `src/accounting.ts`, `src/wait.ts`, and `src/prompts.ts` contain reusable rules alongside coding-agent-specific logic.
- `src/lifecycle.ts`, `src/runtime.ts`, `src/persistence.ts`, and `src/run-protocol.ts` depend on Pi events, session entries, and settled-idle dispatch. Do not reproduce those dependencies in durable.
- Upstream examples `12-tasks`, `13-recovery`, `22-subagent-foreground`, `23-subagent-background`, and `28-reviewer` demonstrate checkpoints, absolute sleeps, ownership, request-ID deduplication, and continuation. They do not prove Goal's finite-response or budget guarantees.
- The repository pins durable `1.2.0`; the inspected `/home/narumi/src/pi` checkout is `1402973a9` with manifest version `1.3.0`. Verify the pinned release before relying on local examples.

## Execution status

**Blocked at the first runtime safety gate.** Real-Harness characterization tests against the pinned published release show that native generation hooks cannot deny a request, blocked tools do not stop the enclosing model loop, and deferred/compaction requests bypass generation request hooks. Replay-safe tool recovery also bypasses `beforeTool`. The API implementation must not proceed without the separate supported API/dependency or host-wrapper decision required below.

The [safety-gate audit](../../packages/pi-goal/test/durable-safety-audit.md) records the public API branches, deterministic probes, available ownership/idempotency behavior, and remaining requirements. The 12 characterization tests pass; several deliberately assert the unsafe boundary behavior, so this is not a passing safety gate. No production API, public exports, settings, or dependencies have changed. All implementation and completion checks remain open; retain this plan.

## Scope

Include host-only start, inspect, edit, pause, resume, wake, and clear operations, plus native `goal_complete`, `goal_blocked`, and `goal_wait` tools. Preserve explicit evidence requirements, stale-goal rejection, response/no-progress limits, token accounting, and quiet external waits.

Use a dedicated task-owned execution conversation for the first durable API. The host receives its ID and can display its transcript. This is an explicit difference from the existing same-session `/goal` workflow, which remains unchanged. The host supplies the initial task context and reviewed agent configuration; do not copy unrelated conversation history implicitly.

Defer custom UI, slash commands for durable, automatic adoption of arbitrary host input, the coding-agent event-bus RPC/mutex protocols, multi-goal queues, legacy-session migration, and automatic activation of forked goals. No other extension is required or identified.

## Applicable MUST rules and verification

| Touched area | Required rule | Verification |
| --- | --- | --- |
| Package boundary | Keep the existing Pi entry and independently usable package; isolate optional runtime imports and publish matching output/declarations. | Import/build tests, metadata review, packed consumers, Pi loader smoke. |
| Lifecycle and ownership | Release all owned work, scope cancellation precisely, and revalidate mutable state after every await. | Delayed-operation, replacement, abort, close, and recovery tests. |
| State and effects | Persist fork-sensitive state; serialize conflicting mutations; do not claim exactly-once external effects. | Atomic transition, replay, fork, and fault-injection tests. |
| Tools | Reject stale calls, bound input/output, preserve cancellation, and make failures observable. | Native tool and nested-call tests. |
| Model context | Keep tool definitions and ordinary prefixes stable; persist deterministic contracts and restore only when absent. | Normalized provider-input tests across transitions and compaction. |
| Settings and release | Preserve existing settings behavior, add no speculative environment variables, document experimental scope, and add a changeset. | Settings regression, README/semantic audits, root checks, and pack inspection. |

Apply `docs/extension-conventions.md`, `docs/extension-settings.md`, `docs/readme-conventions.md`, and `packages/pi-goal/AGENTS.md`. Coding-agent lifecycle rules remain authoritative for that runtime; use durable ownership and task boundaries for the new entry rather than inventing `agent_settled` events.

## Architecture

### Public boundary and ownership

Add `src/durable.ts` exporting `createDurableGoal()` with a native extension, typed host control, and read-only state access. Host mutations require an operation ID and expected Goal identity/revision. Construction, inspection, and observer attachment must not start or resume execution.

The host owns storage, Harness lifecycle, registry, authorization, provider credentials, and execution environments. Persist one foreground supervisor task owned by the source conversation and its dedicated task-owned execution conversation atomically. Source-conversation abort reaches this tree; Goal pause, replacement, and clear target only the supervisor's owned tree, never a broad source-conversation abort that could stop unrelated work. Do not introduce a background cancellation escape in this release.

The first supported host profile requires `settings.compaction.backgroundTokens` in the host's Harness options to remain `0` from before scheduling Goal work until all Goal-owned work is terminal. This is a Harness-wide setting, not part of the execution conversation's agent configuration. Published durable defaults enable conversation-owned background compaction, which ordinary supervisor cancellation does not reach. Reject start, resume, and wake under an incompatible profile; revalidate it at recovery and before admitting new Goal-owned provider requests or tools. A profile change must stop new admission and cancel/join the owned tree without aborting unrelated conversations. Blocking compaction remains subject to ownership, accounting, and request limits.

Conversation ownership is immutable. After an aborted supervisor, resume creates a new supervisor and a task-owned fork of the last valid committed execution boundary, not a reassignment or revival of the old tree. Preserve predecessor links and cumulative token/response/no-progress accounting, rotate activation identity, and configure the reviewed agent before another submission. Do not fork a partial assistant/tool round as if it were a completed boundary.

The supervisor checkpoints delivery, reconciliation, continuation admission, and waiting. Use stable submission request IDs derived from persisted Goal/operation identities. Save intent before submission and reconcile existing submissions after a crash. Do not use a process-local queue, timer, or event listener as the only record of pending work.

### Authoritative state

Use a versioned, rewindable conversation document with `fork: "asOf"` for the host-visible Goal record. Store objective, owning conversation, Goal identity, activation generation, status, supervisor/execution IDs, operation/submission receipts, safety limits/counters, accounting cursor, active elapsed time, and optional absolute wake deadline. Bound records and payloads; retain only receipts required for supported idempotency and recovery.

Keep waiting canonically active with explicit wait metadata. Other states distinguish paused, blocked, usage-limited, budget-limited, complete, and cleared. Plain assistant prose never marks completion. Model lifecycle tools require the exact active Goal identity and valid evidence; host controls are not model-callable.

Reconcile Goal state when the supervisor terminates outside a host control operation. Its abort handler must finalize state after owned work drains, but faults and orphaning can bypass that handler; durable's built-in terminal cleanup does not update custom Goal documents. Prove a persisted native reconciliation path for those terminal receipts that does not depend on observers or the failed supervisor running again. In an identity-checked transaction, reconcile final committed usage and counters, stop active elapsed accounting, invalidate obsolete continuation/wake metadata, and record the terminal receipt. Transition an otherwise active or waiting Goal to paused after cancellation or blocked after a fault/orphan, with an observable reason. Preserve accepted terminal states and never mutate a newer activation. Recovery must finish pending reconciliation before admitting another Goal request; construction and passive inspection must remain non-scheduling.

A fork inherits historical objective/status for review, not authority to spend or references it may control. Reject execution when the stored activation conversation does not match the current one. Explicit host resume creates fresh ownership and rotates identity before a fork can work. Existing admitted tasks remain pending on reopen until the host deliberately drives durable scheduling; observation alone must not do so.

### Safety and accounting

Keep the existing finite defaults: 25 automatic responses and 3 no-progress turns. Explicitly validate any host choice to disable a guard. Keep objective, completion/blocker evidence, and wait-delay limits aligned with the current package. Do not publish a reduced safety implementation under a parity claim.

Reconcile committed assistant entries and documented usage/task/submission records, not `watchEvents()` delivery counts. Count tool-loop responses and relevant retries/recovery, not just final submissions. Persist the accounting cursor with each state transition and distinguish model usage, compaction usage, and tool-reported usage without double counting. Document the durable budget's chosen spend boundary; do not silently substitute all of `pi.usage` for the current assistant-token contract. Preserve finite/nonnegative validation and reasoning/cache-subset rules.

A supervisor that waits for a final answer cannot alone bound an internal tool loop. Prove an exact-version public fail-closed request boundary before promising response or token limits. The just-finished response may overshoot a token budget, but no additional Goal-owned provider request or substantive tool may start after exhaustion is known. A token budget is not a dollar cap.

`HookApi` exposes committed document reads and task memos, not arbitrary commits or cancellation. Use native task/tool APIs for authoritative writes. Do not cast hooks to a task runtime, use a throwing notification hook as a stop signal, or assume a read-only `onYield` can persist cumulative counters across successor tasks. The default design has the supervisor admit another submission only after reconciliation; any hook-driven continuation must satisfy the same finite, crash-safe admission rule.

### Waits, interruption, and context

`goal_wait` persists its reason/deadline, stops automatic continuation, and terminates when used alone. Use a durable sleeping task for an absolute deadline; use persisted state without polling for indefinite waits. Explicit host wake and deadline wake race through one identity-checked transaction. Do not extend a stored deadline after reopening. Cancellation of a wait context is not cancellation of already admitted work.

Complete/block/wait execution must recognize already accepted results on replay and reject stale generations inside the handler, including recovery that bypasses `beforeTool`. Classify explicit quota/billing exhaustion separately from rate limits and server failures; exhausted transient retries wait quietly rather than trigger an automatic retry loop. Compaction failures need a distinct recoverable or blocked outcome, not success.

Append a deterministic Goal contract when activated and a superseding inactive contract on stop. Carry changing budgets/counters in new tail messages or tool results, not leading sections. Compaction restoration must be persisted, deduplicated, and must not wake a waiting Goal. Preserve historical messages and document each identity or mode transition as a new prefix baseline.

## Plan

- [ ] **Resolve the runtime safety gate before implementation.** Against published durable `1.2.0`, build real-Harness fixtures for task-owned conversation cancellation, idempotent submission, tool-loop response accounting, and fail-closed request/tool admission at limit exhaustion. Verify hook authority and retry/compaction ordering from public APIs and runtime behavior. Prove host-profile validation rejects background compaction before Goal work starts, including changed settings and reopen, and prove persisted Goal-state reconciliation after source abort, supervisor fault, and orphaning without observer delivery. If any required admission or reconciliation mechanism is absent, stop this plan and request a separate supported API/dependency decision; do not weaken limits or add a private hook workaround.
- [ ] **Specify the ownership and state contracts.** Define host operations, states, identity rotation, operation replay/conflicts, spend attribution, fork behavior, and cancellation scope in `packages/pi-goal/docs/durable.md`. Acceptance: transition/ownership tests cover every allowed edge, new-tree resume with preserved accounting, and rejection of stale or cross-conversation control without effects.
- [ ] **Extract only required runtime-neutral rules.** Separate objective/evidence validation, prompt escaping, repeat detection, usage normalization, and wait validation from coding-agent dependencies. Acceptance: existing tool schemas, command behavior, safety defaults, settings, and lifecycle suites remain unchanged and pass.
- [ ] **Implement native state, supervisor, and host controls.** Add `src/durable.ts` and focused state/task modules; create the owned execution conversation and supervisor with one committed identity, and use stable request IDs for delivery. Acceptance: crash injection before/after intent, submission, and receipt commits creates no duplicate logical kickoff/continuation and never controls unrelated tasks.
- [ ] **Implement terminal tools and guards.** Add native complete, blocked, and wait tools with bounded results, exact Goal identity, evidence validation, explicit termination, and replay receipts. Acceptance: tests reject stale IDs, stopped/budget-limited completion, contradictory evidence, inactive/nested helpers, and delayed old-goal execution after replacement; mixed parallel terminal calls cannot create conflicting terminal states.
- [ ] **Implement bounded accounting and continuation.** Use the proven request-boundary mechanism and a persisted reconciliation cursor for every Goal-owned response, including tool loops and applicable retries. Acceptance: tests prove finite limits, no-progress pauses, explicit usage exhaustion, one-response token overshoot only, no post-exhaustion work, and unchanged results with detached/overflowed observers.
- [ ] **Implement waits, recovery, and contract publication.** Add durable deadlines and explicit wake, owned-tree cleanup, supervisor terminal-receipt reconciliation, fork guards, provider/compaction failure classification, and deterministic tail-contract restoration. Acceptance: close/reopen, due/indefinite waits, simultaneous wake/deadline, pause/clear/edit/replacement races, stale continuations, and compaction all preserve state without duplicate work or lost cancellation; source abort, supervisor fault, and orphaning reconcile final accounting and remove obsolete wake/continuation metadata without changing newer activations or accepted terminal states.
- [ ] **Add the public build, metadata, and compatibility tests.** Generate `dist/durable.js` plus declarations separately from the existing Jiti graph; add the subpath export and optional host peers after inventorying supported current import paths. Acceptance: generated-import checks and packed ESM/type consumers pass; durable imports do not load coding-agent/TUI registration, and the existing Pi extension still loads without durable.
- [ ] **Document and verify the bounded first release.** Add a minimal synthetic-provider host example, compatibility/ownership/state diagrams, explicit differences from same-session `/goal`, and a package changeset. Run the verification below and audit the full diff against applicable guides before handoff.

## Verification

Keep deterministic suites under `packages/pi-goal/test/durable*.test.ts` and exercise a real Harness with scripted providers and persistent reopen tests. Keep every test within 5,000 ms and synchronize on readiness or committed state instead of fixed sleeps.

Test crash points at each intent/effect/receipt boundary; user cancellation versus wait cancellation; partial initialization; Harness close/failure; replacement during delayed provider/tool work; direct and nested calls; duplicate/conflicting operation IDs; stale identities after every await; response/no-progress/token bounds; transient versus quota failures; tool and compaction usage; zero work from passive observation; fork-as-of; and cache-sensitive model prefixes. Verify that arbitrary input cannot impersonate Goal control or reset its safety epoch.

Exercise context sizes that would trigger background compaction under published defaults: an incompatible host profile must reject before Goal work starts, and the supported profile must leave no background summarization task, surviving provider request, or late summary after source abort or Goal pause. Cover live profile changes and reopening before scheduler activation. With observers detached, test source abort, a throwing supervisor phase, and an orphaned supervisor without a Goal host mutation; verify canonical stopped state, final accounting, and no obsolete wake. Inject a crash between task termination and document reconciliation, then verify recovery completes reconciliation without duplicate work. Race these paths with replacement and accepted completion/blocking/clearing to prove stale cleanup cannot overwrite them.

Run from the repository root, without concurrent Kit builds/checks:

```bash
npm install
npm run check
npm test
npm --workspace @narumitw/pi-goal run build
npm run package:pack -- goal
```

Inspect the tarball and test packed JavaScript/declaration consumers with the exact supported peers. Smoke the unchanged package with `pi -e ./packages/pi-goal`, including a lazy menu boundary. Run a headless synthetic-provider example through start, wait, reopen, explicit wake, completion, and owned cleanup. Do not make live paid requests. Record blocked smokes and unresolved safety gates as incomplete.

## Rollback / Recovery

The durable API is opt-in and does not rewrite current Pi sessions, settings, or legacy Goal state. Stop the supervisor and join its owned execution tree before removal; detaching observers does not stop execution. If storage fails, retain operation IDs and reopen the same store for receipt reconciliation rather than submitting a replacement objective blindly. Reject unsupported state/task versions without overwriting them. Restore a compatible adapter to inspect, pause, or clear retained state. No code path promises exactly-once external tool effects, and no publication/tag/release workflow is authorized by this plan.

## Completion Checklist

- [ ] Published-version safety fixtures prove ownership, accounting, and pre-request/pre-tool enforcement; no private APIs or unbounded fallback remain.
- [ ] Host controls and all three tools reject stale, conflicting, exhausted, or cross-conversation authorization.
- [ ] Limits, evidence rules, deadlines, restart/fork behavior, and provider/compaction failures pass deterministic tests.
- [ ] The supported host profile rejects background compaction and profile changes before new Goal work, and cancellation leaves no surviving Goal-owned work.
- [ ] Source abort, supervisor faults/orphaning, and interrupted terminal-receipt reconciliation produce correct canonical state and final accounting without observers or stale cleanup effects.
- [ ] Owned cleanup, passive-observer behavior, and normalized model-prefix contracts pass lifecycle and recovery tests.
- [ ] The public ESM/types, packed consumer, existing Jiti runtime, and root gates pass; current coding-agent behavior remains compatible.
- [ ] Documentation, safety differences, changeset, semantic audits, deviations, and unverified paths are recorded.
- [ ] After implementation and all checks are complete, delete this plan and report the deleted path.
