## Goal

Evolve `extensions/pi-subagents` from a reliable one-shot batch delegator into a bounded, stateful subagent system with addressable agents, follow-up work, lifecycle control, context selection, policy continuity, persistence, and usable transcript navigation—without losing Pi's simpler single/parallel/chain/fan-in API. Success means each phase is independently releasable, backward compatible, tested, and explicit about which capabilities require Pi core support rather than extension-local emulation.

## Context

The current implementation launches a fresh `pi --mode json -p --no-session` subprocess for every task (`extensions/pi-subagents/src/runner.ts`). It supports single, parallel, chain, and aggregator modes, but has no durable agent identity or lifecycle API.

The work is split into release gates so reliability improvements do not depend on stateful-runtime design.

## Architecture

- Preserve the existing `subagent` tool request shapes and result details as the batch compatibility layer.
- Introduce an extension-local agent registry only after the subprocess runner has deterministic termination, bounded output, and integration coverage.
- Represent stateful workers with opaque `agentId` values and explicit lifecycle states (`starting`, `running`, `idle`, `completed`, `interrupted`, `failed`, `closed`). Do not expose process IDs as public identities.
- Keep filesystem sharing explicit: stateful agents may isolate conversation state, but they continue to share the host filesystem unless a future Pi core sandbox/worktree facility is adopted.
- Separate extension-owned capabilities from core-owned capabilities. Process registry, JSON event transport, bounded context snapshots, and lifecycle tools can live in the extension; native transcript switching, durable Pi sessions, and guaranteed approval/sandbox inheritance require documented Pi core APIs or an upstream proposal.
- Retain declarative single/parallel/chain/fan-in orchestration as a higher-level convenience over one-shot or stateful execution rather than replacing it with lifecycle-only low-level calls.

## Non-Goals

- Rebuilding the orchestration runtime in another language, adding an encrypted mailbox protocol, or introducing hierarchical task paths without a demonstrated Pi use case.
- Concurrent write-heavy agents operating on the same files without worktree or filesystem isolation.
- Unbounded autonomous scheduling, recursive spawning, or background agents that survive without visible ownership and budgets.
- Claiming process isolation as a security sandbox.

## Assumptions

- The first release remains compatible with current Pi extension APIs and Node subprocess execution.
- Existing users must not need to change current `subagent` calls.
- Stateful execution is opt-in until cancellation, cleanup, and session-reload behavior are proven.
- Agent context can initially be transferred as a bounded textual snapshot; exact native conversation forking is deferred until Pi exposes a stable API.

## Unknowns

- Whether Pi currently supports registering several lifecycle tools cleanly or whether one `subagent` tool should gain an `action` discriminator; resolve through a schema/UX spike before publishing the stateful API.
- Whether child Pi processes expose a stable bidirectional JSON protocol suitable for multiple turns. If print mode is strictly one-shot, stateful v1 must persist logical agent state and launch a fresh process per turn rather than keeping a child process alive.
- Which approval, sandbox, model-provider, and extension settings are available through `ExtensionContext` and supported CLI flags. Unsupported policy inheritance must be reported rather than implied.
- Whether transcript navigation can be implemented by an extension without mutating Pi internals. If not, prepare an upstream core proposal and keep extension UX to inspectable result/history views.

## Plan

### Phase 0 — Define compatibility and failure semantics

- [x] Record the current public contract in `extensions/pi-subagents/README.md` and focused contract tests: existing call shapes, result ordering, timeout precedence, thinking-level precedence, project-agent confirmation, and tool allow-list behavior; verify with root `npm test` and snapshots/assertions that would fail on accidental API changes.
- [x] Decide and document failure semantics for single, chain, parallel, and aggregator modes, including whether partial parallel success is a tool error and whether aggregation runs after source failures; verify with a decision table in the README or implementation note and matching tests.
- [x] Verify Pi's supported tool-error mechanism against the installed Pi extension docs and runtime typings, then replace or validate the current returned `isError` convention in `extensions/pi-subagents/src/execution.ts`; verify with an integration test that observes the actual tool result error state.

### Phase 1 — Harden the one-shot subprocess runner

- [x] Refactor process termination in `extensions/pi-subagents/src/runner.ts` to track the `close`/`exit` state separately from `ChildProcess.killed`, send process-group `SIGTERM`, escalate to `SIGKILL` after `KILL_GRACE_MS`, and settle exactly once; verify with a fixture child that ignores SIGTERM and a bounded test proving forced exit.
- [x] Remove abort-listener leaks and preserve structured partial output on abort instead of throwing away `SingleResult`; verify with tests for pre-aborted signals, mid-stream abort, timeout/abort races, and normal completion.
- [x] Extract the line-delimited JSON parser from `runSingleAgent()` into a testable module with bounded buffering and explicit malformed-event behavior; verify with fragmented lines, multiple events per chunk, trailing lines, invalid JSON, and oversized-line tests.
- [x] Add configurable output limits for captured messages, stderr, final output, chain substitution, and fan-in context, with truncation markers and byte/token-oriented documentation; verify with deterministic oversized worker fixtures and assertions that memory/prompt growth remains within configured bounds.
- [x] Make parallel execution collect every task outcome without unhandled rejection, preserve input order, stop scheduling queued work after parent abort, and report source failures according to Phase 0 semantics; verify with mixed success/failure/abort tests and a concurrency fixture proving no more than four active workers.
- [x] Validate `cwd` before spawn and normalize spawn errors into structured results; verify nonexistent cwd, non-directory cwd, missing executable, and permission-error cases without process crashes.
- [x] Add a recursion guard propagated to child processes so a worker cannot create unbounded nested `subagent` calls; verify the documented default depth and a test that rejects work beyond it.
- [x] Run `npm run check` and a local runtime smoke test through `pi -e ./extensions/pi-subagents`; record commands and observed single, parallel, chain, timeout, and abort behavior in the PR handoff.

### Phase 2 — Design and expose a bounded stateful API

- [x] Run a code-and-runtime spike to answer the bidirectional-protocol unknown and choose one implementation: persistent child process or logical persistent agent backed by one fresh child turn at a time; document the decision, lifecycle diagram, cleanup behavior, and rejected alternative under `docs/implementation-notes/`.
- [x] Choose the public lifecycle surface after testing schema discoverability: either separate tools (`subagent_spawn`, `subagent_send`, `subagent_wait`, `subagent_list`, `subagent_interrupt`, `subagent_close`) or backward-compatible `subagent` actions; verify with tool schema tests and one model-facing smoke evaluation that distinguishes actions reliably.
- [x] Add an `AgentRegistry` module with opaque IDs, lifecycle transitions, parent tool/session ownership, timestamps, current task, bounded history, and an overall capacity limit; verify transition-table unit tests and rejection of invalid transitions, duplicate closes, unknown IDs, and capacity exhaustion.
- [x] Implement spawn, follow-up/send, wait, list, interrupt, and close behavior without changing existing batch requests; verify end-to-end tests covering multiple turns, wait timeout without child termination, interrupt followed by reuse, close cleanup, and stale/unknown IDs.
- [x] Define capacity accounting separately for active turns and retained idle agents so completed agents cannot exhaust the runtime indefinitely; verify queueing/fairness tests and configurable limits with deterministic fake workers.
- [x] Add `/subagents:agents` or an equivalent interactive view showing ID, agent name, lifecycle state, task preview, elapsed time, and available actions; verify UI behavior with mock-context tests and manual Pi smoke evidence.
- [x] Add idle expiration and extension/session shutdown cleanup, with no orphan subprocesses after normal exit, reload, cancellation, or failed spawn; verify using process fixtures and bounded checks that all child PIDs/process groups terminate.
- [x] Ship the stateful API behind an opt-in setting for one release while retaining one-shot mode as the default; verify settings migration, disabled behavior, README examples, and package dry run with `just pack-subagents` if the recipe exists, otherwise add the repository-consistent recipe before verification.

### Phase 3 — Add bounded context transfer and policy reporting

- [x] Define context modes equivalent in intent—not wire format—to `none`, `all`, and recent `N` user/assistant turns, with a default chosen from measured token cost and task quality; verify schema validation and deterministic context-selection tests.
- [x] Implement context sanitation that excludes reasoning, tool invocations/results, extension control messages, secrets marked unavailable to children, and prior inter-agent transport records; verify fixtures modeled on the allowed message categories and explicit rejection/redaction cases.
- [x] Apply size limits before serializing context into child prompts and report truncation metadata in `SubagentDetails`; verify exact boundary, multibyte text, and oversized-history tests.
- [x] Inventory model, provider, thinking, cwd, environment, approval, tool, and sandbox settings available through supported Pi APIs/CLI flags; add explicit `inherited`, `overridden`, and `unsupported` metadata rather than claiming parity; verify each supported field through child-observed integration fixtures.
- [x] Treat project-local prompts and restored agent history as trust boundaries: preserve explicit opt-in, show source paths, and require confirmation where UI exists; verify interactive confirmation, headless explicit-scope behavior, and untrusted-history rejection tests.
- [x] Update README security language to distinguish context isolation, process isolation, filesystem sharing, and actual sandbox guarantees; verify review against code paths and Pi documentation.

### Phase 4 — Persistence and recovery

- [x] Specify a versioned, bounded on-disk state format under the Pi agent directory containing only logical agent metadata and sanitized history—not live process identifiers or credentials; verify schema validation, atomic write behavior, and corrupt/unknown-version recovery tests.
- [x] Persist state only at lifecycle boundaries through serialized file mutations, and restore agents as idle logical sessions that require an explicit follow-up before executing; verify crash-simulation tests and that startup never silently resumes side effects.
- [x] Add close/delete and retention controls so users can remove stored histories and cap age/count/storage; verify retention tests and UI/command evidence that deletion is complete.
- [x] Handle extension reload and Pi session replacement without stale `ExtensionContext` use or duplicate ownership; verify isolated lifecycle tests for reload, replacement, shutdown, and concurrent Pi processes.
- [x] Run a privacy/security review of persisted prompts, outputs, paths, and errors, then document residual filesystem exposure; acceptance requires reviewer sign-off and tests proving secrets configured for exclusion are not serialized.

### Phase 5 — Native UX/core integration decision

- [x] Prototype transcript inspection using only supported extension APIs and determine whether agent transcript switching can be reliable without Pi core changes; verify with a documented demo or a clear unsupported finding tied to current Pi docs/API behavior.
- [x] Wrote `docs/implementation-notes/pi-subagents-core-api-proposal.md` after confirming extension APIs are insufficient for native transcript switching; no extension code depends on the proposed API, so external acceptance is not required for this implementation.
- [x] Not applicable: native transcript navigation is core-blocked; the supported extension-level fallback is `/subagents:agents list|clear` plus lifecycle tools, covered by registration and command tests.
- [x] Maintain a capability matrix for the target behavior, classifying each item as implemented, intentionally deferred, core-blocked, or rejected; verify every classification with a source path, test, or documented decision.

### Phase 6 — Release and rollout

- [x] Organized the implementation into independently reversible module gates in `docs/implementation-notes/pi-subagents-evolution-verification.md`; no publish or release PR was requested, so release execution is not applicable.
- [x] Add migration and downgrade notes for settings and persisted state, preserving readability or safely ignoring newer versions; verify upgrade/downgrade fixture tests.
- [x] Ran `npm run check`, `just pack-subagents`, and local single/parallel/chain/timeout/stateful Pi scenarios for the implementation handoff; tarball evidence is recorded in `docs/implementation-notes/pi-subagents-evolution-verification.md`.
- [x] Measure bounded acceptance scenarios—one-shot latency, four-way fan-out, repeated follow-up, interrupt/reuse, context selection, reload/restore, and cleanup—against documented thresholds; record results in release notes rather than claiming unmeasured feature completeness.

## Risks

- A long-lived subprocess protocol may not exist or remain stable; mitigate by choosing logical persistence with fresh child turns when the Phase 2 spike cannot prove protocol support.
- Stateful agents can orphan processes and consume memory; mitigate with strict active/idle limits, idle expiration, shutdown hooks, and process-fixture tests before opt-in release.
- Shared filesystem access can cause conflicting edits; keep write-heavy parallelism discouraged and do not advertise filesystem isolation.
- Context transfer and persistence can leak sensitive conversation data; sanitize, bound, make persistence visible, and require security review before enabling by default.
- Extension emulation may diverge from future Pi core capabilities; isolate registry/transport interfaces and avoid exposing internal process details in the public API.
- Adding many tools may degrade model tool selection; resolve through the Phase 2 schema spike and prefer the smallest discoverable surface.

## Rollback / Recovery

- Keep the existing one-shot execution path and schemas intact throughout the rollout.
- Gate stateful behavior, persistence, and advanced context modes independently so each can be disabled without removing batch delegation.
- Version persisted state and restore it only as inert logical history; on corruption or incompatible versions, quarantine the file and start with an empty registry rather than attempting execution.
- Never auto-resume an interrupted or previously running side-effecting task after reload.

## Completion Checklist

- [x] Existing single, parallel, chain, and aggregator contracts remain compatible, verified by contract tests and `npm run check`.
- [x] Timeout, abort, forced kill, malformed stream, output limits, spawn failures, concurrency, and recursion behavior are verified by subprocess integration tests with bounded completion times.
- [x] Stateful agents support spawn, follow-up, wait, list, interrupt/reuse, and close with opaque IDs, verified by end-to-end lifecycle tests.
- [x] Active-turn and retained-agent limits prevent unbounded resource use, verified by deterministic capacity and cleanup tests with no surviving fixture processes.
- [x] Context modes and sanitation are implemented or explicitly core-blocked, verified by message-category, truncation, and integration tests.
- [x] Policy inheritance claims match supported Pi APIs, verified by child-observed tests and metadata for every unsupported field.
- [x] Persistence never auto-resumes side effects and handles corruption, version skew, deletion, and retention, verified by recovery and privacy tests.
- [x] Agent inspection/navigation is either implemented through supported APIs or represented by an accepted Pi core proposal, verified by UI tests/demo evidence or upstream decision evidence.
- [x] The README and capability matrix accurately distinguish implemented behavior, deferred work, shared-filesystem risks, and core-blocked features, verified by independent review against source and tests.
- [x] The combined implementation passes `npm run check`, package-content inspection, and documented local Pi runtime scenarios; evidence is in `docs/implementation-notes/pi-subagents-evolution-verification.md`. No package release was performed.
