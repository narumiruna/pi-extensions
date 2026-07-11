# pi-subagents native runtime alignment

Date: 2026-07-11

## Implemented

- A transport-neutral registry accepts `SubagentTransport`; default `SubprocessTransport` preserves the current child invocation, opt-in `InProcessTransport` owns public-SDK child sessions, and a function adapter keeps tests deterministic.
- Agents now persist `parentId`, `rootId`, `depth`, ordered children, bounded mailboxes, stable message IDs, deduplication keys, and read state.
- Parent completion is delivered exactly once into the parent mailbox. `subagent_message` does not start a turn; `subagent_send` consumes mailbox context and starts a follow-up.
- Subtree interrupt and close use child-first order. Restore rejects orphaned/cyclic hierarchy and always returns valid records as inert.
- Context supports none, all, recent N, summary checkpoint plus recent messages, and selected session entry IDs with stable source IDs.
- Shared-workspace write-capable concurrency is blocked by default. Opt-in disposable detached worktrees require a clean repository and are removed on close or shutdown.
- `/subagents:agents` renders hierarchy indentation, unread counts, state, elapsed time, and available actions.

## Public SDK boundary

Pi now publicly exports enough SDK surface for extension-owned in-memory child sessions: `createAgentSession()`, `SessionManager.inMemory()`, `DefaultResourceLoader`, model/settings registries, subscriptions, abort, and disposal. `InProcessTransport` uses only those exports and disables child extension loading to prevent recursive delegation and duplicate side effects.

The SDK still does not expose inherited resolved approval/sandbox policy, provider-header hooks, extension state, core-global child scheduling, or interactive transcript switching. The extension does not import private paths, cast runtime objects, monkey-patch `ExtensionAPI`, or claim these unsupported capabilities. `docs/implementation-notes/pi-subagents-core-api-proposal.md` now documents the remaining gap rather than blocking in-process execution. Subprocess remains the default fallback.

## Persistence and compatibility

Older records without hierarchy or mailbox fields migrate to root agents with empty children/mailboxes. New state remains versioned and bounded. Worktree agents are closed rather than restored because their disposable workspace is removed at shutdown. Existing one-shot and stateful tool shapes remain valid; all new parameters and tools are additive.
