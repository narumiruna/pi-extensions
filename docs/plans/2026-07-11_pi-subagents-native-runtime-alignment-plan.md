## Goal

Move `pi-subagents` from persistent logical agents toward a native multi-agent runtime with long-lived child sessions, asynchronous messaging, hierarchical ownership, policy continuity, transcript navigation, and recovery. Success means the extension exposes consistent agent lifecycle semantics while using Pi core APIs for capabilities that cannot be implemented safely through subprocess emulation.

## Context

The current implementation already provides:

- one-shot single, parallel, chain, and fan-in workflows;
- opaque stateful agent IDs;
- follow-up, wait, list, interrupt, and close operations;
- FIFO active-turn scheduling and retained-agent limits;
- bounded parent-context snapshots and sanitized logical history;
- versioned persistence with inert recovery;
- deterministic subprocess timeout and cancellation.

The remaining gap is primarily architectural. A follow-up currently launches a fresh `pi --mode json -p --no-session` subprocess and reconstructs continuity through text. Pi extensions do not currently expose native child-session handles, bidirectional turns, child transcript switching, or guaranteed approval/sandbox propagation.

## Architecture

Introduce a transport abstraction beneath `AgentRegistry`:

```ts
interface SubagentTransport {
  create(options: CreateAgentOptions): Promise<AgentHandle>;
  send(id: string, input: AgentInput, options: SendOptions): Promise<void>;
  wait(id: string, options: WaitOptions): Promise<AgentStatus>;
  interrupt(id: string): Promise<void>;
  close(id: string): Promise<void>;
  restore(record: PersistedAgent): Promise<AgentHandle>;
}
```

Implement two transports:

1. `SubprocessTransport` preserves the current behavior and remains the compatibility fallback.
2. `NativeSessionTransport` uses future supported Pi child-session APIs for long-lived context, events, transcript access, and policy inheritance.

Keep `AgentRegistry` responsible for IDs, hierarchy, capacity, lifecycle validation, and persistence metadata. Keep provider conversation state and transcript ownership inside Pi core when the native transport is available.

## Non-Goals

- Do not emulate native session behavior through undocumented Pi internals or private imports.
- Do not claim filesystem isolation while agents share the same workspace.
- Do not automatically resume interrupted side effects after restart.
- Do not enable unbounded recursive spawning or autonomous scheduling.
- Do not remove the existing batch APIs or subprocess fallback.

## Assumptions

- The existing stateful API remains backward compatible while transport internals evolve.
- Native child-session support requires an upstream Pi API before it can be completed safely.
- Agent hierarchy and mailbox semantics can be implemented in the extension before native transcript switching is available.
- All new behavior remains opt-in until capacity, cleanup, persistence, and permission tests pass.

## Unknowns

- Whether Pi core will expose one API for both in-process child sessions and subprocess-backed sessions.
- Whether child-session approval requests should be routed to the root transcript, child transcript, or both.
- Whether filesystem isolation should use worktrees, sandboxes, or a provider-neutral execution profile.
- Which transcript-navigation primitives can be exposed without replacing the active root session.

## Plan

### 1. Stabilize the transport boundary

- [ ] Extract child execution from `extensions/pi-subagents/src/stateful.ts` into `SubagentTransport`, with `SubprocessTransport` reproducing current behavior exactly; verify with existing lifecycle tests and `npm run check`.
- [ ] Add transport contract tests covering create, send, wait timeout, interrupt, close, restore, shutdown, partial output, and transport failure; verify the same suite passes against a deterministic fake transport and `SubprocessTransport` fixtures.
- [ ] Move child-process-specific policy metadata out of `AgentRegistry` into transport results so registry state remains transport-neutral; verify serialized records from the current version still restore through migration tests.

### 2. Add hierarchical agent ownership

- [ ] Extend `ManagedAgent` with `parentId`, `rootId`, `depth`, and ordered `children`, while preserving opaque public IDs; verify root, child, and grandchild creation with deterministic tree tests.
- [ ] Enforce configurable maximum depth, total retained agents, active turns, and per-parent child limits before starting work; verify boundary and concurrent-spawn race tests.
- [ ] Implement subtree-aware list, interrupt, close, and shutdown operations with child-before-parent cleanup; verify no descendant remains running or persisted after subtree close.
- [ ] Persist hierarchy atomically and restore every record as inert until explicitly resumed or sent follow-up work; verify corrupt, orphaned, cyclic, duplicate, and missing-parent records are rejected or quarantined.

### 3. Add asynchronous mailbox semantics

- [ ] Split current follow-up behavior into `send_message` and `followup_task`: messages enter a bounded mailbox without starting a turn, while follow-up tasks enqueue a turn; verify delivery ordering and state-transition tests.
- [ ] Add parent and child completion mailboxes so final output can arrive without a blocking wait call; verify exactly-once delivery across completion, interrupt, close, and reload races.
- [ ] Add message IDs, sender/recipient IDs, timestamps, read state, retention limits, and deduplication keys; verify duplicate delivery and persistence replay tests.
- [ ] Expose bounded `subagent_messages` list/read/ack operations, or fold them into the existing lifecycle tools if schema evaluation shows better model selection; verify tool-schema tests and a local model smoke matrix.

### 4. Improve context and turn continuity

- [ ] Replace ad hoc text concatenation with a versioned structured turn-history format that preserves user/assistant boundaries and truncation metadata; verify upgrade and downgrade fixtures.
- [ ] Add context policies for `none`, `all`, recent N turns, summary plus recent turns, and explicit selected entries; verify sanitation excludes reasoning, tool transport records, private markers, and unsupported media.
- [ ] Add a bounded summarization checkpoint when logical history exceeds its limit, keeping the latest tasks and outputs verbatim; verify deterministic fallback when summarization fails or is aborted.
- [ ] Prevent context duplication between parent snapshots, mailbox messages, and prior turns by assigning stable source IDs; verify repeated follow-ups do not multiply identical context.

### 5. Strengthen permissions and workspace safety

- [ ] Define a transport-neutral `AgentExecutionPolicy` containing cwd, model, thinking level, tools, environment policy, approval mode, sandbox profile, and unsupported guarantees; verify every field is explicitly inherited, overridden, or unsupported.
- [ ] Route project-local agent definitions through Pi project trust for spawn, restore, and follow-up operations, including hierarchy descendants; verify interactive, headless, disabled-confirmation, and trust-revocation tests.
- [ ] Add an optional isolated-workspace strategy for write-capable agents, initially using disposable Git worktrees only when the repository is clean and the user opts in; verify path containment, branch cleanup, dirty-repository refusal, cancellation, and conflict reporting.
- [ ] Keep shared-workspace mode as the default and block concurrent write-capable siblings unless the user explicitly overrides the conflict guard; verify tool-list classification and scheduling tests.

### 6. Prepare native Pi core integration

- [ ] Convert `docs/implementation-notes/pi-subagents-core-api-proposal.md` into an upstream-ready proposal with child-session creation, send, interrupt, close, event subscription, context fork, transcript inspection, policy inheritance, and global capacity contracts; verify the proposal against current Pi extension/session documentation.
- [ ] Implement a compile-time experimental adapter only after supported child-session APIs exist; verify no private package paths or undocumented runtime objects are imported.
- [ ] Run the transport contract suite against the native adapter and require behavioral parity for lifecycle, cancellation, restoration, hierarchy, and mailbox delivery before enabling it.
- [ ] Add feature detection and settings migration so native transport is preferred when supported while subprocess transport remains an explicit fallback; verify upgrade, downgrade, missing-API, and forced-fallback tests.

### 7. Add transcript and team UX

- [ ] Expand `/subagents:agents` into a selector showing hierarchy, role, state, current task, unread messages, elapsed time, and available actions; verify narrow-terminal rendering and command/UI tests.
- [ ] Add transcript inspection when supported by Pi core, keeping closed agents inspectable without switching or invalidating the root session; verify navigation, reload, and stale-context tests.
- [ ] Add shortcuts for previous/next agent and return-to-root only after keybinding conflicts and focus behavior are covered by TUI tests.
- [ ] Render mailbox delivery and completion events as compact transcript entries with expanded details; verify event ordering and snapshot tests.

### 8. Verification and rollout

- [ ] Add integration fixtures for hierarchy, mailbox, persistence, policy, subprocess cleanup, and transport fallback; verify bounded execution times and no surviving child processes.
- [ ] Run `npm run check`, `just pack-subagents`, and local Pi smoke scenarios for batch compatibility, hierarchy, messaging, interrupt/reuse, reload/restore, and fallback transport.
- [ ] Maintain a capability matrix classifying each target as implemented, native-API blocked, intentionally deferred, or rejected, with source/test evidence for every row.
- [ ] Release transport abstraction, hierarchy/mailbox, workspace guards, native adapter, and transcript UX as separate commits or PRs so each layer can be reverted independently.

## Risks

- Native API availability may delay transcript and policy parity; mitigate by keeping those tasks explicitly blocked behind supported core contracts.
- Mailbox and hierarchy state introduce ordering races; mitigate with serialized registry mutations, stable message IDs, and deterministic concurrency tests.
- Logical context summaries can lose critical instructions; retain recent turns verbatim and expose summary/truncation metadata.
- Worktree isolation can leave branches or directories behind after crashes; use ownership markers, startup cleanup, and explicit recovery commands.
- More lifecycle tools can reduce model tool-selection accuracy; evaluate separate tools versus action-based schemas before stabilizing the public API.
- Persisted messages may contain sensitive data; apply the same sanitation, size limits, file permissions, deletion, and retention controls as agent history.

## Rollback / Recovery

- Keep persisted state versioned and migrate through copies rather than in-place destructive rewrites.
- Preserve `SubprocessTransport` and current batch tools as the fallback for every native-adapter release.
- Restore agents as inert records after crashes; require explicit follow-up before any side effect resumes.
- Provide subtree close, mailbox clear, state quarantine, and isolated-workspace cleanup commands before enabling those features by default.

## Completion Checklist

- [ ] Transport abstraction preserves current behavior, verified by shared transport contract tests and existing batch/lifecycle suites.
- [ ] Agent hierarchy enforces ownership, depth, capacity, subtree cleanup, and inert restoration, verified by deterministic tree and corruption tests.
- [ ] Mailbox operations provide bounded, ordered, deduplicated, exactly-once parent/child delivery, verified across completion and reload races.
- [ ] Structured context avoids duplication and preserves bounded recent turns, verified by sanitation, migration, summary-failure, and source-ID tests.
- [ ] Execution policy reports every supported and unsupported guarantee, verified through child-observed integration tests.
- [ ] Concurrent write risks are bounded by shared-workspace guards or opt-in isolated workspaces, verified by conflict and cleanup fixtures.
- [ ] Native child sessions are either implemented through supported Pi APIs or remain explicitly blocked with an upstream proposal; no private APIs are used.
- [ ] Agent/team inspection and transcript UX are verified by command, TUI, navigation, and stale-context tests for every supported surface.
- [ ] Backward compatibility and fallback behavior pass `npm run check`, `just pack-subagents`, package inspection, and documented local Pi smoke scenarios.
- [ ] The capability matrix and user documentation match the shipped behavior, verified by source/test review before release.
