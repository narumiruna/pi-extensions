# Async runtime protocol

This document defines `pi-subagents:completion-requirement:v1` and the current runtime boundary for final-answer-dependent detached work.

## Requirement identity

A caller marks one `subagent_spawn` or `subagent_send` turn with `completionRequirement: "required"`.
The runtime binds that requirement to the accepted `agentId`, executor-owned `runId`, and monotonically increasing turn generation.
Agent names and task paths are display and addressing aids and never replace exact run identity.
Omitting the field or using `background` preserves prior behavior and does not create a final-answer dependency.

## State ownership

`AgentRegistry` owns requirement transitions with the child turn and persisted completion outbox.
Tool-result `details.agent.completionRequirements` provides fork-sensitive branch evidence.
Session restoration retains exact requirements found on the active branch and treats sessions without visible subagent state as a possible compacted continuation.
The successful lifecycle tool result and delivered completion message are the ordinary model-visible requirement handoff.
When a resume changes a pending run to cancelled and interrupted while its stale handoff remains in model context, `before_agent_start` appends one hidden versioned transition after that handoff.
This append-only transition also applies when leading summaries retain the stale handoff, prevents duplicate publication on later turns, and participates in fork-sensitive branch reconstruction.
If leading compaction or branch summaries remove the handoff, the `context` hook restores one canonical hidden `pi-subagent-required-completions` fallback immediately after the summaries.
A branch-local custom session entry records the exact restored boundary so reload and tree navigation reconstruct the correct historical fallback.
The fallback remains at that fixed boundary for the leading-summary epoch, while a later completion or cancellation transition supersedes it at the conversation tail.
`CompletionDeliveryBroker` owns exact completion visibility acknowledgement and asks the registry to mark the corresponding requirement visible.
No timer, waiter, or UI object owns requirement truth.

## States

A newly accepted exact run enters `pending`.
A durably persisted terminal completion moves the exact run to `available` and records its completion ID and terminal child state.
Observation of that exact completion ID in the intended parent context moves the run to `visible`.
Interruption, close, restore of a non-running owner, or shutdown moves an unfinished requirement to `cancelled` with an explicit terminal state.
Duplicate completion delivery and acknowledgement are idempotent.
A follow-up receives a new run ID and generation and creates a requirement only when that follow-up explicitly requests one.
The runtime bounds retained requirement records per agent and rejects a sixty-fifth unresolved required run before acceptance so every unresolved exact identity fits in the canonical parent context.

## Parent behavior

Pending and available requirements remain final-answer dependencies.
A newly established canonical fallback omits requirements already visible at that boundary.
A fallback retained from an earlier request remains historical prefix context after visibility changes, and the later completion message supplies the superseding state.
Cancelled requirements are terminal and must be reported rather than silently treated as successful evidence.
A failed, partial, interrupted, stale, or cancelled child never satisfies mutating acceptance or independent-verification requirements merely because its turn settled.

## Prompt-cache boundary

Provider-visible subagent tool definitions and prompt metadata remain stable within one configured tool-surface epoch.
A versioned hidden session-guidance message carries the bounded agent catalog, completion delivery, capacity, cwd policy, and consultation resource policy without placing mutable values in leading tool metadata.
The initial guidance contract is persisted once before the first agent turn when no equivalent retained contract exists.
A successfully applied live policy change appends a superseding guidance contract without triggering a model turn.
Compaction restores missing guidance and required-completion fallbacks in deterministic order after leading summaries.
These rules preserve normalized cache-eligible prefixes across ordinary turns but do not guarantee a provider-reported cache hit.

## Budget termination

Omitted limits use runtime or agent policy and are recorded as runtime-sourced telemetry.
Explicit timeout, idle, turn, and tool-call limits remain compatible and are recorded as explicit sources.
A limit stop with non-empty successful bounded finalization becomes a typed `partial` outcome with the exact termination reason.
Empty finalization, failed finalization, malformed required structured output, and transport failures remain failed or contract-invalid.
Partial evidence is available to the parent but is not successful verification or mutating acceptance.

## Pi core boundary

The inspected supported Pi runtime emits provider `message_update` events before the TUI, RPC, JSON, and SDK surfaces display them.
An extension `message_end` handler can replace the finalized same-role message but cannot retract previously displayed deltas.
Steering is queued after the extension `input` event, direct RPC steering bypasses that event, and tool abort signals do not observe every accepted steer.
Therefore an extension cannot provide a hard pre-display final-answer barrier or a reliably steer-interruptible join across all supported modes.
`subagent_await` remains the bounded non-polling compatibility join and accurately states that queued steering is blocked until the tool settles.

A future core implementation would need replay-safe post-enqueue input activity, exact session-owned blocker handles, pre-display buffering or suppression, bounded timeout, and abort, replacement, reload, shutdown, and headless-mode semantics.
This repository does not modify or publish Pi core packages for this work.

## Codex reference

Codex `wait_agent` uses replay-safe pending activity plus an event-driven watch receiver for mailbox and steering activity.
Codex completion context uses a typed `FINAL_ANSWER` envelope with explicit task, sender, and payload fields.
Codex rollout budgets use shared runtime-owned accounting and acknowledge reminders only after context insertion.
These patterns inform waiting, completion identity, and budget ownership, but Codex also does not provide an absolute pre-display final-answer barrier.

## Compatibility fallback

Older persisted agents without requirement metadata behave as background work.
Current Pi versions continue using bounded persisted at-least-once completion delivery and optional idle-root auto-resume.
The package must not claim that prompt guidance, context injection, automatic delivery, or finalized-message replacement is a hard barrier.
The deprecated synchronous `subagent` tool remains available for unmatched chain, fan-in, panel, workflow, and compatibility callers.
