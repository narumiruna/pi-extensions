## Goal

Add an opt-in in-process child-session transport to `pi-subagents` using Pi's public `createAgentSession()` SDK. A stateful subagent must retain one real `AgentSession` across initial work and follow-up turns, while preserving the current subprocess transport as the default compatibility and rollback path.

Success means repeated turns reuse the same child session, abort/close/shutdown release it deterministically, restored logical agents can lazily recreate a child session from bounded sanitized history, and existing one-shot and subprocess behavior remain unchanged. Background spawning must also avoid the anti-pattern of delegating one critical-path task and leaving the main agent idle.

## Context

The current stateful runtime stores logical agent identity and bounded task/output history in `AgentRegistry`, but `SubprocessTransport` launches a fresh `pi --mode json -p --no-session` process for every turn. The transport boundary already exists in:

- `extensions/pi-subagents/src/transport.ts`
- `extensions/pi-subagents/src/subprocess-transport.ts`
- `extensions/pi-subagents/src/registry.ts`
- `extensions/pi-subagents/src/stateful.ts`

Pi 0.80.3 publicly exports `createAgentSession()`, `AgentSession`, `DefaultResourceLoader`, `SessionManager`, and `SettingsManager`. `ExtensionContext` also exposes `model`, `modelRegistry`, `cwd`, and `getSystemPrompt()`. A local no-provider smoke test verified that an extension-compatible process can construct and dispose an in-memory SDK session with extensions and tools disabled.

The repository implementation notes that classify native child sessions as wholly API-blocked are therefore stale. Dedicated core APIs are still missing for exact parent extension-state cloning, resolved approval/sandbox inheritance, built-in transcript switching, and global root-plus-child concurrency accounting.

## Architecture

Introduce `InProcessTransport` beside `SubprocessTransport`:

```text
AgentRegistry
    |
    +-- SubprocessTransport   (default, existing behavior)
    |
    +-- InProcessTransport    (opt-in)
            |
            +-- Map<agentId, ChildSessionRecord>
                    - AgentSession
                    - event subscription
                    - last output/error/usage
                    - creation metadata
```

`InProcessTransport.runTurn()` will lazily create a child session on the first turn, call `session.prompt()` for each task, subscribe to public `AgentSession` events for bounded output and usage, and reuse the same session for follow-ups. Parent context and restored logical history are seeded once at session creation rather than concatenated into every later prompt.

Extend the transport lifecycle only as far as required for deterministic resource ownership:

```ts
interface SubagentTransport {
  readonly kind: "subprocess" | "in-process" | "fake";
  runTurn(agent: ManagedAgent, task: string, signal: AbortSignal): Promise<TurnOutcome>;
  release?(agent: ManagedAgent): Promise<void>;
  shutdown?(): Promise<void>;
}
```

`AgentRegistry` remains authoritative for IDs, hierarchy, scheduling, lifecycle states, mailboxes, persistence metadata, and completion delivery. The transport owns provider conversation state and session disposal.

Use a purpose-built `DefaultResourceLoader` with `noExtensions: true` for child sessions. It may load normal context files, skills, and prompt templates, but it must not rediscover `pi-subagents` or arbitrary parent extensions. Append the selected agent's system prompt through the resource loader. Resolve the child model through the existing `ModelRegistry`; inherit the current parent model only when the agent definition has no explicit model.

## Non-Goals

- Do not add or monkey-patch `pi.createChildSession()` onto the global `ExtensionAPI`.
- Do not use private Pi imports, runtime casts, or undocumented `AgentSession` fields.
- Do not switch Pi's built-in transcript or add agent-navigation shortcuts in this phase.
- Do not claim exact approval, sandbox, provider-header, or arbitrary extension-state inheritance.
- Do not enable autonomous recursive child spawning in this phase; child sessions will not load `pi-subagents` as an extension.
- Do not migrate the one-shot `subagent` single/parallel/chain/fan-in path away from subprocesses.
- Do not publish or bump the package version as part of implementation unless requested separately.

## Assumptions

- `stateful.transport` will accept `"subprocess"` and `"in-process"`; omission continues to mean `"subprocess"`.
- The first in-process release supports Pi built-in tools. If an agent requests an extension/custom tool that cannot be reconstructed from public metadata, creation fails with a bounded actionable error instead of silently dropping the tool or loading all extensions.
- Existing persisted logical records remain transport-neutral. Changing the configured transport affects the next explicitly started follow-up; restored work remains inert.
- Child sessions use `SessionManager.inMemory()` initially. Cross-process persistence continues through the existing sanitized logical state rather than new child JSONL files.
- No automatic fallback occurs after an explicitly selected in-process transport fails. Users can return to `"subprocess"` without changing stored agent records.

## Unknowns

- Whether SDK context restoration is safest through pre-populating `SessionManager` entries or assigning documented `session.agent.state.messages`; resolve this with an early round-trip test and choose the path that keeps `session.messages` and `SessionManager.getBranch()` consistent.
- Whether every existing frontmatter model alias accepted by the Pi CLI resolves in SDK mode. Resolved: `resolveCliModel()` is not exported from the installed package root, so the transport uses public `ModelRegistry` methods for exact provider/id, unique id/name/fuzzy matching, and `:thinking` suffixes, with bounded ambiguity errors.
- Whether a child session aborted during provider retry always settles `session.prompt()` promptly; verify with a deterministic fake child-session contract and one real SDK abort smoke when configured credentials are available.

## Plan

- [x] Make stateful lifecycle tools available by default and add Codex-aligned anti-idle guidance: do critical-path work locally, reserve blocking single-agent calls for worthwhile isolation/review, use background `subagent_spawn` only with identified sidecar work, and do not wait immediately while useful non-overlapping main-agent work remains; verify prompt-metadata regression tests and local smoke prompts exercise overlap.

- [x] Add failing settings tests in `extensions/pi-subagents/test/evolution.test.ts` for `stateful.transport: "subprocess" | "in-process"`, default subprocess selection, and rejection of unknown values; verify the intended red state with `npm test` before modifying `extensions/pi-subagents/src/agents.ts` and `settings.ts`.

- [x] Add a narrow child-session adapter contract in a new package-local module, with injectable session creation for tests and only the public methods needed by the transport (`prompt`, `subscribe`, `abort`, `dispose`, messages/tool inspection); verify TypeScript rejects private Pi imports with `npm run typecheck` and repository search `rg 'pi-coding-agent/(src|dist)/' extensions/pi-subagents/src` returns no private-path imports.

- [x] Resolve the two SDK discovery unknowns with focused tests: seed a child conversation and assert both `session.messages` and `SessionManager.getBranch()` preserve user/assistant order, then exercise explicit and inherited model selection through public `ModelRegistry` methods with CLI-compatible suffix parsing; record the selected restoration path and alias behavior in test names and `docs/implementation-notes/pi-subagents-stateful-runtime.md`.

- [x] Implement a child resource-loader factory in a focused source module using `DefaultResourceLoader({ noExtensions: true, ... })`, normal cwd/agentDir resource discovery, and the resolved agent system prompt; verify with tests that child extension discovery is empty, built-in agent prompts are present, project context follows the trusted parent cwd, and `pi-subagents` is not registered recursively.

- [x] Implement `InProcessTransport` with a per-agent `AgentSession` map, lazy creation, first-session-only context/history import, bounded event/output collection, timeout-to-`session.abort()`, parent abort propagation, normalized `TurnOutcome`, and session reuse across follow-ups; verify with contract tests that two turns create one session, the second prompt contains only the new task, prior assistant context remains in the session, timeout returns exit code 124, interrupt returns 130, and a later follow-up remains usable.

- [x] Validate requested tools before starting an in-process child: allow the SDK-supported built-ins, preserve an explicit empty tool list, and reject unavailable extension/custom tool names with an error that recommends `stateful.transport: "subprocess"`; verify tests cover `scout`, `worker`, no-tools, and a configured unknown extension tool without silently widening permissions.

- [x] Extend `SubagentTransport` and `AgentRegistry` with deterministic per-agent release semantics, invoking release after explicit close, subtree close, idle expiry, failed creation cleanup, and session shutdown; verify transport-spy tests prove exactly-once disposal, child-before-parent subtree release, no release on wait timeout, and no live session remains after `registry.shutdown()`.

- [x] Wire transport selection in `extensions/pi-subagents/src/stateful.ts` while keeping the current `SubprocessTransport` construction unchanged for the default; maintain a parent runtime snapshot updated from `session_start`, `model_select`, and `thinking_level_select` so newly created children inherit the current model/thinking level rather than a stale startup value, and verify mock event tests select the expected transport and runtime snapshot.

- [x] Preserve persistence and workspace behavior across transports: lazily reconstruct restored in-process children from sanitized bounded `context` and `history`, never resume work automatically, and dispose the child session before cleaning an owned worktree; verify version-1/version-2 persistence fixtures, inert restore tests, private-marker redaction, and real worktree cleanup tests under both transport selections.

- [x] Add extension-level lifecycle tests that enable `stateful.transport: "in-process"`, run spawn → wait → follow-up → wait → interrupt/reuse → close through registered tools with an injected fake SDK session factory, and assert existing subprocess tool shapes and result details are unchanged; verify with root `npm test`.

- [x] Add a local SDK smoke fixture that creates an extension-free in-process child using the installed public package, confirms a stable child session ID across two deterministic mocked turns or skips only the provider-dependent prompt portion with an explicit reason, and always disposes the session; verify the fixture leaves no session files, timers, or extension registrations behind.

- [x] Update `extensions/pi-subagents/README.md` with the transport setting, continuity semantics, built-in-tool restriction, same-process crash/isolation tradeoff, no exact policy inheritance, and subprocess rollback instructions; verify every documented setting matches `normalizeSubagentSettings()` tests and package defaults.

- [x] Correct stale implementation notes in `docs/implementation-notes/pi-subagents-core-api-proposal.md`, `pi-subagents-native-runtime-alignment.md`, `pi-subagents-native-runtime-verification.md`, `pi-subagents-stateful-runtime.md`, and `pi-subagents-capability-matrix.md`: classify SDK-owned in-process sessions as implementable while retaining core-blocked transcript/policy/global-capacity items; verify each capability row cites current source or test evidence.

- [x] Run the release-equivalent gates `npm run check` and `just pack-subagents`, inspect the dry-run tarball for every new source file and the unchanged `src/subagents.ts` entrypoint, then run local Pi smokes for default subprocess stateful behavior and opt-in in-process spawn/follow-up/close; record command results in `docs/implementation-notes/pi-subagents-native-runtime-verification.md`.

- [x] Perform an independent edge-case review of session ownership, abort races, provider failure, missing model/auth, custom tool rejection, extension recursion, project trust, worktree cleanup, reload/shutdown, and restored-state migration; verify all release-blocking findings have regression tests and `npm run check` remains green.

## Risks

- Loading normal extensions in a child could duplicate side effects or recursively load `pi-subagents`; mitigate with `noExtensions: true` and explicit tests.
- In-process sessions share the parent Node.js failure domain; mitigate by keeping subprocess as the default and documenting that in-process isolation is contextual, not crash or security isolation.
- The parent extension context does not expose executable definitions for arbitrary active tools; mitigate by rejecting unsupported tools instead of silently changing capabilities.
- Aborting a child during provider retry or tool execution may race with close/shutdown; mitigate with idempotent release, awaited abort settlement, and exactly-once disposal tests.
- Importing restored logical history into a real session may duplicate parent context; mitigate by seeding only at session creation and retaining stable source IDs and existing byte bounds.
- `DefaultResourceLoader` may discover project-controlled resources beyond the selected agent prompt; mitigate by reusing the trusted parent cwd decision and documenting which resource classes are loaded.
- SDK behavior may change across peer-compatible Pi versions; mitigate with public-import-only typechecks, a runtime capability probe, explicit initialization errors, and subprocess rollback.

## Rollback / Recovery

- Set `stateful.transport` back to `"subprocess"` and reload Pi; existing logical agent records remain readable and inert until explicitly followed up.
- Keep all existing batch and subprocess source paths and tests intact; do not rewrite persisted state solely to support in-process sessions.
- On in-process initialization failure, return a bounded actionable error and dispose any partially created session. Do not silently restart the same task in a subprocess because that could duplicate side effects.
- On reload or shutdown, abort active child turns, await settlement within a bounded cleanup window, dispose every session, and persist records as idle without automatically resuming work.

## Completion Checklist

- [x] One stateful agent reuses one public Pi `AgentSession` across at least two turns, verified by transport contract and extension-level tests that observe one creation and two prompts with retained conversation state.
- [x] Default subprocess behavior and all one-shot APIs are unchanged, verified by existing suites plus `npm run check` with no schema regressions.
- [x] In-process abort, timeout, close, subtree close, expiry, reload, and shutdown leave no owned live sessions, verified by exactly-once disposal and lifecycle race tests.
- [x] Restored records remain inert and can lazily continue through either configured transport without private text or duplicate context, verified by persistence/context migration fixtures.
- [x] Child resource loading cannot recursively load `pi-subagents` or arbitrary extensions, verified by resource-loader inspection tests and a local SDK smoke.
- [x] Unsupported extension/custom tools fail explicitly without permission widening, verified by tool-validation tests and README rollback guidance.
- [x] Exact policy inheritance, built-in transcript switching, autonomous recursive teams, and global concurrency remain accurately marked unsupported/non-goals, verified by updated capability documentation.
- [x] Package quality and publish contents pass `npm run check` and `just pack-subagents`, with the tarball containing all new source files and no generated or temporary artifacts.
- [x] Local subprocess and in-process smoke evidence, commands, and known limitations are recorded in `docs/implementation-notes/pi-subagents-native-runtime-verification.md`.
