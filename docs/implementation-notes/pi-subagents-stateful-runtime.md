# pi-subagents stateful runtime decision

Date: 2026-07-11

## Decision

Use logical persistent agents backed by a fresh `pi --mode json -p --no-session` subprocess for each turn.

Pi print/JSON mode exposes a one-shot newline-delimited event stream, not a documented bidirectional protocol for steering a child through multiple turns. Keeping an undocumented process protocol alive would make cancellation, reload, and compatibility fragile. The extension therefore owns stable agent IDs, bounded sanitized history, lifecycle state, capacity, and persistence while retaining the existing proven child invocation.

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
- `running` owns one `AbortController` and child process.
- `subagent_wait` times out only the caller's wait.
- `subagent_interrupt` aborts a queued/running turn but preserves identity and prior history.
- `subagent_close` aborts current work and excludes the record from persistence.
- Session shutdown aborts active work and persists every non-closed record as inert `idle` state.

## Cleanup

The child runner sends process-group SIGTERM and escalates to SIGKILL after five seconds based on observed process closure, not Node's `ChildProcess.killed` signal-sent flag. Abort listeners, timers, and process listeners are removed at settlement. Session shutdown drains queued work without starting it, aborts active controllers, waits for settlement, and writes inert logical records.

## Public surface

Separate lifecycle tools were selected instead of adding an `action` discriminator to `subagent`:

- preserves the existing batch schema exactly;
- gives each operation a small schema and precise model-facing description;
- lets users opt in to the entire surface with `stateful.enabled`;
- avoids ambiguous combinations between lifecycle actions and batch fields.

The existing `subagent` tool remains the preferred API for one-shot single, parallel, chain, and fan-in work.

## Context and policy boundary

Parent context is opt-in (`none`, `all`, or recent N user turns), text-only, sanitized, and bounded. Tool results, reasoning, custom messages, and image data are excluded. The extension can explicitly control cwd, model, thinking level, and child tool names. Current supported APIs do not provide a reliable way to clone parent approval decisions, sandbox profiles, or provider headers into the child invocation, so result metadata marks those guarantees unsupported.

## Rejected alternative

A permanently running child would reduce repeated startup latency and could preserve native child history, but no stable input protocol, session ownership contract, or transcript handle is exposed for that use. It was rejected until Pi core provides explicit child-session handles and lifecycle APIs.
