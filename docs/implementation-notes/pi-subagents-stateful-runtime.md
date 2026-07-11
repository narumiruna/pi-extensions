# pi-subagents stateful runtime decision

Date: 2026-07-11
Updated: 2026-07-11

## Decision

Keep the existing logical stateful registry and support two transports:

- `subprocess` (default): start a fresh `pi --mode json -p --no-session` child for every turn and replay bounded sanitized history.
- `in-process` (opt-in): retain one public Pi SDK `AgentSession` per stateful `agentId` and send follow-ups directly to that session.

Stateful lifecycle tools are registered by default and can be removed with `stateful.enabled: false`. The default transport remains subprocess for compatibility and rollback safety.

## In-process ownership

The extension constructs children only with public SDK APIs: `createAgentSession()`, `SessionManager.inMemory()`, `DefaultResourceLoader`, `SettingsManager`, `ModelRegistry`, and documented `AgentSession` methods.

Each child receives:

- the agent system prompt;
- an in-memory session seeded once with sanitized parent context and prior user/assistant turn boundaries;
- the selected cwd, model, thinking level, timeout, and built-in tool allow-list;
- a resource loader configured with `noExtensions: true` to prevent recursive extension loading and duplicate side effects.

An existing child keeps its session configuration. Parent model/thinking changes are snapshotted only when a later child is created. Explicit models resolve through public `ModelRegistry` exact provider/id or unique id/name/fuzzy matching, with CLI-compatible `:thinking` suffix parsing and bounded ambiguity errors. Unsupported extension/custom tools fail before child creation and recommend `subprocess`; the runtime never silently widens tools or falls back after a failed in-process start.

## Lifecycle

```text
spawn -> starting -> running -> completed
                  |         -> failed
                  |         -> interrupted
                  v
             FIFO capacity queue

completed/failed/interrupted -> follow-up -> starting
any retained state -> close -> closed
restored persisted state -> idle -> explicit follow-up -> starting
```

- `starting` means queued for an active-turn slot.
- `running` owns one `AbortController` and one transport turn.
- `subagent_spawn` returns immediately; prompt guidance requires useful non-overlapping main-agent work before waiting.
- `subagent_wait` times out only the caller's wait.
- `subagent_interrupt` aborts a queued/running turn but preserves identity and settled history.
- `subagent_close` aborts current work, releases transport ownership exactly once, and excludes the record from persistence.
- Session shutdown aborts active work, drains queued work, persists non-closed records as inert `idle`, and shuts down every owned child session.

## Cleanup

Subprocess cleanup retains process-group SIGTERM/SIGKILL escalation. In-process cleanup calls `AgentSession.abort()` and `dispose()`. Timeout and parent abort allow a bounded settlement grace; a child that remains unsettled is disposed and removed instead of being reused. Close, TTL eviction, and session shutdown release child ownership deterministically.

## Public surface

Separate lifecycle tools preserve the existing batch `subagent` schema and give each operation a precise contract. `subagent` remains the blocking API for single, parallel, chain, and fan-in work. `subagent_spawn` is the background sidecar API and must not be used to delegate one immediate critical-path blocker while the main agent idles.

## Context and policy boundary

Parent context is opt-in (`none`, `all`, `summary`, recent N user turns, or selected entry IDs), text-only, sanitized, and bounded. Tool results, reasoning, custom messages, and image data are excluded.

Neither transport claims to clone parent approval decisions, sandbox profiles, provider-header extension hooks, or extension state. In-process children also do not provide global core scheduling or parent/child transcript switching. Result metadata marks these guarantees unsupported.
