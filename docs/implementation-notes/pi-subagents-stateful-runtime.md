# pi-subagents stateful runtime decision

Date: 2026-07-11
Updated: 2026-07-23

## Decision

Keep the existing logical stateful registry and support two transports:

- `subprocess` (default): start a fresh `pi --mode json -p --no-session` child for every turn and replay bounded sanitized history.
- `in-process` (opt-in): retain one public Pi SDK `AgentSession` per stateful `agentId` and send follow-ups directly to that session.

Stateful lifecycle tools are registered by default and can be removed with `stateful.enabled: false`. The default transport remains subprocess for compatibility and rollback safety.

Detached completion is configurable. `stateful.completionDelivery: "next-turn"` is the default Codex-style behavior: the lifecycle observer publishes final status/output with `deliverAs: "steer"` and `triggerTurn: false`. Opt-in `"auto-resume"` holds completion while the root is active, coalesces simultaneous completions, and requests at most one synthesis turn after the parent settles when no input is pending. Completion metadata/output/error fields are independently sanitized and bounded, and session-generation, shutdown, batching, and in-flight wake guards prevent stale or duplicate scheduling pressure. Delivery remains best-effort because Pi's custom-message API is fire-and-forget.

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
- `subagent_spawn` returns immediately; prompt guidance prefers one detached agent covering related asynchronous research/review even when the final answer depends on it, followed by useful non-overlapping main-agent work or ending the response instead of polling.
- Blocking `subagent` batches are reserved for outputs required before the root's next action because queued steering cannot be processed until the call returns.
- Settled turns emit bounded `pi-subagent-completion` custom messages. The default does not wake an idle root; opt-in auto-resume batches a dispatch window and requests one synthesis turn.
- Active parent work is not interrupted; `agent_settled` schedules the held batch. User or extension input already pending at flush time suppresses auto-resume, and a parent `agent_start` acknowledgement clears the pre-set one-wake guard.
- Registry state-change callbacks are serialized in invocation order, preventing a slow `starting` persistence write from overwriting a later terminal snapshot.
- No detached wait tool is exposed; genuinely blocking one-shot work uses the batch `subagent` API.
- `subagent_interrupt` aborts a queued/running turn but preserves identity and settled history.
- `subagent_close` aborts current work, releases transport ownership exactly once, and excludes the record from persistence.
- Session shutdown aborts active work, drains queued work, persists non-closed records as inert `idle`, and shuts down every owned child session.

## Cleanup

Subprocess cleanup retains process-group SIGTERM/SIGKILL escalation. In-process cleanup calls `AgentSession.abort()` and `dispose()`. Timeout and parent abort allow a bounded settlement grace; a child that remains unsettled is disposed and removed instead of being reused. Close, TTL eviction, and session shutdown release child ownership deterministically.

## Public surface

Separate lifecycle tools preserve the existing batch `subagent` schema and give each operation a precise contract. `subagent` remains the blocking API for single, parallel, chain, and fan-in work, but model-facing guidance reserves it for outputs required before the root can continue and explicitly warns that user steering waits. `subagent_spawn` is the preferred detached sidecar API for related asynchronous research/review, even when the final answer depends on its result: scheduling and execution continue independently, settled turns notify the root session according to `completionDelivery`, and no wait operation is exposed. It must not be used to delegate one immediate critical-path blocker while the main agent idles.

`/subagents settings` edits `completionDelivery` through `SettingsList`, patches the canonical raw JSON atomically without dropping unknown fields, and applies the runtime policy immediately. `/subagents status` reports configured versus runtime values; manual file edits remain reload-based. `/subagents:config` remains the compatibility UI for per-agent tool allow-lists and now also patches only the selected agent field.

## Context and policy boundary

Parent context is opt-in (`none`, `all`, `summary`, recent N user turns, or selected entry IDs), text-only, sanitized, and bounded. Tool results, reasoning, custom messages, and image data are excluded.

Neither transport claims to clone parent approval decisions, sandbox profiles, provider-header extension hooks, or extension state. In-process children also do not provide global core scheduling or parent/child transcript switching. Result metadata marks these guarantees unsupported.
