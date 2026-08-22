# Pi Workflow Engine Roadmap

- **Status:** Superseded on 2026-08-22 by [`2026-08-22_pi-plan-mode-side-thread-roadmap.md`](./2026-08-22_pi-plan-mode-side-thread-roadmap.md); retained as historical rationale.
- **Audience:** Pi extension and library maintainers
- **Planning horizon:** Evidence-qualified phases without delivery dates
- **Selected package name:** `@narumitw/pi-workflow-engine`
- **Workflow RPC position:** Deferred until a concrete consumer and transport requirement exist

## Vision

Create one reusable workflow engine that owns the workflow-specific lifecycle logic currently
embedded separately in `pi-plan-mode` and `pi-goal`: state and stage transitions, snapshot schemas,
context artifacts, continuation policy, completion, blocking, cancellation, stale-run protection,
and terminal outcomes. It delegates agent execution, message delivery, physical session persistence,
compaction execution, provider retry, generic JSONL RPC, and extension UI transport to Pi's public
core APIs. Extensions become thin product adapters that retain their commands, menus, settings,
status language, compatibility surfaces, and supported interaction bindings.

The first combined product is a standalone `pi-workflow` extension built from the engine's planning
and managed-execution stages:

```text
planning → plan ready → approved implementation → managed execution → verification → complete
```

`pi-plan-mode` remains the focused planning product, `pi-goal` remains the focused autonomous-goal
product, and `pi-workflow` owns the end-to-end experience without importing or requiring either
extension. Future debugging, review, migration, release, and other agent workflows should reuse the
same stage engine only when concrete consumer evidence supports their semantics.

## Objectives

- **Centralize workflow behavior** — Success: planning and managed-execution state transitions,
  snapshot schemas, lifecycle guards, continuation policy, and terminal outcomes have one
  implementation in `@narumitw/pi-workflow-engine`, not extension-local copies.
- **Reuse Pi's execution substrate** — Success: the engine contains no second agent loop, tool
  executor, message queue, session store, compactor, provider retry loop, JSONL transport, or
  extension UI protocol.
- **Provide one authoritative workflow service boundary** — Success: commands, tools, and UI adapters
  use the same structured operations, results, snapshots, and lifecycle guards without committing to
  a public Workflow RPC contract before a concrete automation consumer exists.
- **Keep extensions thin and independent** — Success: `pi-plan-mode`, `pi-goal`, and `pi-workflow`
  depend on the library but never import or inspect one another; each remains installable and
  functional alone.
- **Compose planning and execution atomically** — Success: `pi-workflow` moves one persisted workflow
  from planning to managed execution without an event-channel handoff, duplicate objective, or two
  completion owners.
- **Preserve focused products during migration** — Success: existing `/plan`, `/goal`, tool names,
  settings, session restoration, statuses, and supported non-TUI behavior remain compatible unless a
  separately approved migration explicitly changes them.
- **Generalize from proven stages** — Success: broader workflow primitives enter the public engine
  only after at least two compatible consumers prove shared transition and lifecycle behavior.

## Current State

- No `pi-workflow-engine` package or shared workflow engine exists.
- `pi-workflow` exists as a stable, independently installable combined extension that currently owns package-local Plan and Goal source snapshots instead of consuming the planned engine.
- `pi-plan-mode` owns planning, approval, restrictive tools, exact plan persistence,
  compaction-safe active-plan context, and manual implementation clearing. Its accepted plan can be
  up to 50,000 characters.
- `pi-goal` owns direct and queued Goal state, continuation, explicit completion and blocking,
  budgets, no-progress protection, workflow persistence policy, tool policy, interruption recovery,
  compaction handling, and terminal publication. Goal objectives are limited to 4,000 characters.
- `pi-goal` also exposes a default-off managed-run protocol through `pi-goal:start`,
  `pi-goal:cancel`, and `pi-goal:event:${runId}`. Under the selected direction, that current contract
  becomes a compatibility adapter around the shared engine rather than the architecture used to
  connect Plan mode to Goal mode.
- No repository consumer currently requires a dedicated `pi-workflow` automation protocol, and Pi
  exposes no public extension point for custom native RPC commands. A new Workflow RPC surface would
  therefore add correlation, authorization, cancellation, recovery, and compatibility costs without
  a validated user workflow.
- Pi's agent core already owns the LLM turn loop, streaming, tool execution, steering/follow-up
  queues, abort, and idle settlement. `AgentSession` adds agent event streaming, provider retry,
  compaction, model/tool management, and extension binding.
- Pi's `SessionManager` already owns append-only JSONL session trees, branches, compaction entries,
  custom state entries, and context reconstruction. Extensions supply their own custom-entry schemas
  and restore policy.
- Pi's process RPC already owns LF-delimited JSON framing, request correlation, generic agent/session
  commands, event streaming, and the extension UI subprotocol. Its public command union is fixed and
  exposes no extension API for registering workflow-specific RPC command or event types.
- Pi's shared `pi.events` bus supports only synchronous listener invocation plus subscribe/unsubscribe;
  it does not await async listener continuations or provide correlation, replay, timeout, listener
  discovery, arbitration, or authorization.
- Pi exposes one process-wide active-tool array. Restrictive Plan mode currently wins, and pi-goal
  pauses rather than re-adding its terminal tools over another extension's selection.
- Repository policy prohibits extension-to-extension dependencies and extension-specific runtime
  assumptions. Focused and combined products may all depend on a publishable non-extension library.
- The repository's existing publishable library pattern requires emitted JavaScript and declarations
  and forbids `pi.extensions` in library manifests.

## Pi Core Boundary

| Capability | Pi core owns | Workflow engine owns |
| --- | --- | --- |
| Agent execution | LLM turns, streaming, tools, abort, awaited agent listeners, idle | Which workflow stage may run and whether its result advances the workflow |
| Message delivery | Prompt, steer, follow-up, queue draining | Continuation intent, ownership, limits, cancellation, and stale-delivery rejection |
| Persistence | JSONL session tree, branches, custom entries, physical writes | Workflow snapshot schema, migration, branch-aware reconstruction, and invariants |
| Compaction and retry | Summarization, context rebuild, overflow/provider retry | Compaction-safe artifacts and workflow state after the Pi lifecycle settles |
| Tools | Registry, validation, execution, one process-wide active array | Stage policy, restrictive restoration, completion ownership, and stale-tool guards |
| Extension UI | TUI/RPC dialogs, status, widget, and notifications | Structured operations and results rendered by product adapters |
| Generic RPC | JSONL framing, core commands/responses/events, request IDs | No custom binding until a separately admitted consumer requires one |
| Shared events | In-process channel subscribe/emit | No public Workflow protocol; any future adapter must own correlation, revisions, timeout, and fail-safe rules |

Pi lifecycle events are authoritative execution facts but not workflow outcomes. In particular,
`agent_end`, `agent_settled`, and idle never imply that a workflow is complete.

## Target Ownership

```text
Pi core runtime
├─ agent and tool execution
├─ prompt, steering, and follow-up delivery
├─ session JSONL, branches, compaction, and provider retry
├─ generic process RPC and extension UI transport
└─ extension lifecycle events and shared event bus

@narumitw/pi-workflow-engine
├─ workflow/stage identity, revisions, transitions, and terminal states
├─ workflow snapshot schema, migration, and branch-aware restoration over Pi entries
├─ lifecycle ownership, cancellation, transition provenance, and stale guards
├─ context artifacts and compaction-safe workflow handoff
├─ managed-continuation policy, budgets, and no-progress protection
├─ completion, blocked, pause/resume, cancel/clear, and approval transitions
├─ transport-neutral workflow service with structured operations and results
├─ planning and managed-execution stage implementations
└─ planning → managed-execution composition

pi-plan-mode
├─ /plan and --plan public interfaces
├─ Plan-mode menus, settings, wording, and status presentation
├─ compatibility tool names and result rendering
└─ focused planning workflow plus its existing implementation-handoff compatibility

pi-goal
├─ /goal public interface and queue manager
├─ Goal menus, settings, wording, and status presentation
├─ compatibility tools and current managed-run protocol adapter
└─ focused workflow using the managed-execution stage

packages/pi-workflow
├─ /workflow public interface and one unified status surface
├─ workflow-specific menus, settings, wording, and tool namespace
├─ workflow manager and interaction adapters over the shared service
├─ planning and managed-execution stage composition
└─ standalone end-to-end product with no extension dependencies
```

The engine owns workflow policy and invariants, not Pi's execution mechanisms. Extensions own
product interaction, compatibility, access settings, channel names, and transport binding. A policy
belongs in an extension only when it is genuinely product-specific and cannot be represented as
stage configuration or an engine-owned transition.

## Guiding Principles

- **Workflow layer, not a second Pi core:** reuse public Pi agent, session, compaction, retry, tool,
  extension UI, and generic RPC capabilities instead of wrapping or reimplementing them.
- **Engine, not broker:** Plan mode does not submit work to an installed Goal provider. Focused and
  combined products instantiate engine-owned stages directly.
- **Service before transport:** define workflow operations once for product-owned commands, tools,
  and UI. Add no public RPC or event-bus control adapter until a concrete consumer proves its caller,
  process boundary, frequent tasks, and recovery requirements.
- **Focused products, one combined product:** `pi-plan-mode` and `pi-goal` stay narrow;
  `pi-workflow` alone owns the end-to-end Plan-to-Execution experience.
- **One state machine:** an approved `pi-workflow` implementation is one workflow transition, not two
  extension states synchronized by events.
- **One completion owner:** the active execution stage alone can complete the workflow; completion
  clears its accepted-plan artifact and presentation state atomically.
- **Thin adapters:** commands, UI, settings, labels, and compatibility aliases stay outside the
  engine; lifecycle and state-transition policy stay inside.
- **Explicit completion:** prose, `agent_end`, and idle settlement never prove completion.
- **Restrictive tools win:** the engine never widens an active restrictive policy or treats Pi's
  whole active-tool array as independently owned slots.
- **Behavior before extraction:** characterize existing Plan and Goal behavior before moving it, then
  migrate one stage at a time without combining unrelated product changes.
- **Evidence before generalization:** support sequential stages and bounded loops first; avoid a
  speculative universal workflow language.

## Roadmap

### Phase 1: Establish pi-workflow-engine

- [ ] `@narumitw/pi-workflow-engine` exists as a publishable non-extension library with bounded APIs
  for workflow definitions, stages, snapshots, artifacts, lifecycle ownership, and a host port backed
  only by Pi's public extension/SDK surfaces.
- [ ] The engine defines a deterministic base state machine covering idle, active stage, paused,
  blocked, failed, complete, and cleared outcomes with at most one committed terminal outcome,
  monotonic workflow/stage revisions, and stale request, stage, and tool-call rejection.
- [ ] One workflow service exposes structured operations and results needed by product-owned
  commands, tools, and UI, so domain transitions have one authoritative implementation without a
  published transport contract.
- [ ] Product adapters call the same workflow service rather than infer state from notifications or
  assistant prose. The package implements no JSONL framing, custom native Pi RPC command, or
  extension-owned event-bus control protocol.
- [ ] Initial planning and managed-execution stages provide the behavior required by the combined
  product, backed by characterization contracts derived from pi-plan-mode and pi-goal without yet
  changing either focused extension's public implementation.
- [ ] Session replacement, fork restoration, shutdown, compaction, synchronous event re-entry, delayed
  continuation, restrictive tool ownership, and repeated cleanup have explicit engine contracts and
  deterministic tests that drive Pi host fakes rather than duplicate Pi internals.
- [ ] Engine instances do not rely on accidental module-singleton behavior when independently
  installed extensions resolve different compatible library copies.
- [ ] The package emits JavaScript and declarations, exposes only supported root exports, declares no
  Pi extension entrypoint, passes focused checks, and produces an inspected dry-run tarball.

**Outcome:** The engine can host both stages behind one reusable product-service boundary while Pi
remains the sole agent, session, compaction, retry, generic RPC, and UI runtime.

### Phase 2: Build packages/pi-workflow from both stages

- [x] `packages/pi-workflow` exists as an independently installable stable extension with a `/workflow` command, one state-aware manager, and no dependency on another extension package.
  It currently uses package-local Plan and Goal source snapshots as an interim architecture.
- [ ] The extension binds its commands, tools, and TUI to the same engine service without adding a
  dedicated Workflow RPC setting, public event channel, or automation protocol.
- [ ] Service-level coverage proves start, snapshots, planning answers, approval or revision,
  pause/resume, cancel/clear, provenance, structured errors, and one terminal outcome without parsing
  notifications or assistant prose.
- [ ] Approving implementation transitions one engine-owned workflow from planning into managed
  execution without pi-goal installation, provider discovery, package-specific events, copied Goal
  objectives, or a second completion owner.
- [ ] The accepted plan remains an engine-owned artifact across implementation turns and Pi-managed
  compaction; successful completion clears workflow context, snapshot, widget, and footer atomically,
  while stopped or failed states retain one resumable workflow.
- [ ] Native `pi --mode rpc` support is described truthfully: `/workflow` may use Pi's existing
  `prompt` and extension UI protocol, but pi-workflow exposes no custom typed RPC commands. No private
  Pi RPC imports or parallel JSONL implementation are introduced.
- [ ] TUI, native extension-UI RPC, print, and JSON behavior is explicit, and package contents, status
  ownership, cancellation, replacement, reload, fork, and shutdown remain correct when neither
  focused extension is installed.
- [ ] End-to-end tests and isolated Pi smokes prove planning, approval, long implementation,
  compaction, verification, explicit completion, and automatic workflow cleanup.

**Outcome:** Users can drive one coherent Plan-to-Execution product through shared operations, and the
internal service boundary remains available if future automation evidence justifies an adapter.

### Phase 3: Make pi-goal use the managed-execution stage

- [ ] `pi-goal` constructs managed-execution workflows through the engine while preserving direct
  `/goal`, queue behavior, `goal_complete`, `goal_blocked`, settings, statuses, session migration, and
  supported TUI/RPC/non-interactive behavior.
- [ ] Run identity, continuation intent and policy, completion and blocked audits, stale-tool guards,
  pause/resume/cancel, interruption recovery, compaction-safe artifacts, no-progress protection,
  usage accounting, optional budgets, and workflow terminal outcomes have one engine implementation;
  Pi continues to own prompt delivery, physical compaction, and provider retry.
- [ ] The current `pi-goal:start`, `pi-goal:cancel`, and `pi-goal:event:${runId}` managed-run contract,
  `rpc.enabled` default, error codes, correlation, event ordering, and terminal behavior remain a
  compatibility adapter over the engine unless a separately approved migration changes them. Removed
  older `pi-goal:rpc:*` channels are not revived.
- [ ] Characterization, migration, restore, queue, tool-policy, retry, compaction, budget, no-progress,
  protocol, and runtime smoke evidence show no Goal regression, and replaced extension-local workflow
  logic is removed rather than retained in parallel.

**Outcome:** pi-goal becomes a focused product adapter over the same managed-execution stage already
proven by pi-workflow.

### Phase 4: Make pi-plan-mode use the planning stage

- [ ] `pi-plan-mode` constructs planning workflows through the engine while preserving `/plan`,
  `--plan`, `plan_mode_question`, `plan_mode_complete`, saved plans, export, settings, menus, statuses,
  and supported TUI/RPC/non-interactive behavior.
- [ ] Planning/ready transitions, accepted-plan normalization, question and approval lifecycle,
  restrictive tool restoration, workflow snapshot schema, exact plan artifacts, compaction-safe
  context, and stale workflow protection have one engine implementation over Pi-managed session
  entries.
- [ ] pi-plan-mode remains the focused planning product and retains its existing ordinary
  implementation-handoff compatibility; it does not become another complete Plan-to-Execution
  product.
- [ ] Ready, saved, handoff, clear, replace, resume, reload, fork, compaction, and failed-delivery
  behavior migrate without unapproved changes, and replaced extension-local planning logic is removed.
- [ ] Focused tests and runtime smokes prove byte-exact plan preservation and compatibility across the
  migration.

**Outcome:** Both focused extensions share the engine with pi-workflow while keeping distinct product
roles: planning-only, goal-only, and combined end-to-end workflow.

### Phase 5: Validate stable coexistence and decide the successor role

- [ ] Co-installation tests cover every supported combination of pi-workflow, pi-plan-mode, and
  pi-goal; unique commands and tools remain distinguishable, restrictive policy is never widened, and
  overlapping autonomous workflows follow one explicit reject-or-serialize decision.
- [ ] Representative real tasks establish whether pi-workflow improves completion, recovery, and
  cleanup without making focused planning or direct Goal usage harder; unsupported adoption targets
  remain explicit unknowns.
- [x] Maintainers approve `pi-workflow` as a stable extension with its current menu, defaults, settings ownership, status language, and compatibility surface.
- [ ] Real consumers determine whether blocked-proposal review, continuation leases, or any additional
  supervision authority from the earlier pi-goal cross-extension proposal belongs in the shared
  workflow service; absent evidence, those hooks remain deferred.
- [ ] Process-level automation evidence determines whether the internal service is sufficient or a
  separately proposed RPC adapter or upstream Pi capability is justified; the engine does not add a
  second JSONL server to close that platform gap.
- [x] Maintainers designate pi-workflow as a stable third option while pi-plan-mode and pi-goal remain active.
  Any primary-successor selection or predecessor deprecation still requires a separate approved decision.
- [ ] Engine, extension, and compatibility checks plus package dry runs and representative Pi smokes
  establish release readiness without implying publication, tags, visibility changes, or version
  changes.

**Outcome:** The repository supports pi-workflow as a stable combined product while gathering evidence for any later primary-successor or predecessor-migration decision.

### Future option: Decide whether Workflow RPC is justified

- [ ] At least one concrete, inspectable consumer identifies who calls the interface, from which
  process, which frequent tasks require automation, and why commands or direct service calls are
  insufficient.
- [ ] A bounded design compares no adapter, direct SDK/service use, an in-process event adapter, and a
  future native Pi RPC extension point against lifecycle, access, cancellation, resynchronization,
  migration, and compatibility costs.
- [ ] Any admitted Workflow RPC receives a separate proposal and explicit approval before operation
  names, versioning, channels, settings, or compatibility commitments enter implementation.

**Outcome:** RPC becomes an evidence-backed, separately approved product capability, or remains
unimplemented without complicating the normal pi-workflow experience.

## Success Metrics

| Indicator | Baseline | Target / invariant | Evidence source |
| --- | --- | --- | --- |
| Workflow state-machine owners for managed execution | pi-goal extension | 1 engine implementation | Ownership audit and migration tests |
| Workflow state-machine owners for planning | pi-plan-mode extension | 1 engine implementation | Ownership audit and migration tests |
| Pi execution mechanisms reimplemented by the engine | No engine | 0 | Package-boundary and source review |
| Workflow operations with command/tool/TUI parity | No shared service | Every admitted product operation | Service and adapter tests |
| Concrete consumers before admitting Workflow RPC | 0 | At least 1 inspectable consumer | Consumer integration evidence and approved proposal |
| Extension-to-extension imports or assumptions | Forbidden | 0 | Boundary checks and source review |
| Terminal outcomes per workflow | Extension-local | At most 1 | Runtime race and lifecycle tests |
| Stale stage clearing newer workflow state | Not centrally covered | 0 | Replacement, reload, and re-entry tests |
| Plan fidelity after implementation compaction | Plan-mode-specific support | Byte-exact engine artifact | End-to-end smoke and context assertions |
| Valid completion owners for one active phase | Potentially separate Plan/Goal concepts | Exactly 1 | Tool-schema and transition tests |
| Existing `/plan` and `/goal` behavior lost during migration | Current baseline | 0 unapproved losses | Characterization and compatibility suites |
| Focused extension dependencies imported by pi-workflow | No combined product | 0 | Boundary checks and package review |
| End-to-end workflows with one completion owner | No combined product | Every pi-workflow run | Integration tests and Pi smokes |
| Broader public primitives without two consumers | No engine | 0 | API review and roadmap evidence |

Adoption and task-completion-rate targets remain TBD because the repository has no telemetry or
validated usage baseline.

## Risks and Dependencies

| Risk or dependency | Impact | Mitigation / decision |
| --- | --- | --- |
| “All logic” turns the engine into a monolith or second Pi runtime | A shared package could duplicate mature agent/session infrastructure and become harder to change | Limit “all” to workflow-domain logic; separate state machine, stages, snapshots, artifacts, service operations, and composition while delegating execution and storage to public Pi APIs. |
| pi-goal behavior is large and lifecycle-sensitive | A big-bang extraction could regress retries, budgets, queues, or stale guards | Establish characterization tests, prove the stage in pi-workflow, and migrate pi-goal in bounded reversible slices. |
| Initial engine stages temporarily coexist with extension-local logic | Behavior can drift before focused migrations complete | Freeze characterization contracts, keep Phase 3–4 migrations sequenced, and remove replaced logic rather than maintaining permanent forks. |
| Public tools and commands belong to extensions | Moving logic could accidentally break names, schemas, or rendering | Keep adapter-owned registrations and map them onto engine operations with exact compatibility tests. |
| Pi's global active-tool array has no composable ownership | Two workflows could widen or erase another policy | Keep restrictive-wins semantics, activate only at safe boundaries, and centralize exact snapshot/rollback behavior in the engine. |
| Plan and Goal persisted schemas already exist | Runtime state could strand resumed sessions or forks | Define explicit import/migration adapters and test legacy, current, clear-marker, and malformed branch states. |
| Plan and Goal have different size and context contracts | A naïve common objective could truncate plans or inflate every continuation | Model accepted plans as workflow artifacts distinct from bounded execution objectives. |
| Multiple installed copies cannot safely share module globals | Cross-extension coordination could become version- or resolver-dependent | Make engine ownership explicit through Pi/session surfaces; never require one process-global JavaScript singleton for correctness. |
| Pi native RPC has a fixed public command union | A custom Workflow RPC could be misrepresented or lead to a duplicate JSONL server | Add no Workflow RPC now; retain a transport-neutral internal service and reopen transport design only for an admitted consumer or upstream Pi extension point. |
| `pi.events` does not await async listeners or provide protocol services | A future event adapter could lose replies or run stale continuations | Do not use it as a Workflow control protocol by default; any separately approved adapter must define correlation, revisions, idempotency, timeout, fallback, and resynchronization. |
| Existing managed-run RPC is documented behavior | Extraction could create an unapproved breaking change | Preserve the current unversioned start/cancel/run-event contract as a pi-goal adapter until a separately approved compatibility decision says otherwise. |
| Three product adapters can overlap in commands, tools, settings, and user expectations | Co-installation could be confusing even without code coupling | Give pi-workflow a unique namespace, test every supported combination, and make Phase 5 own the coexistence or successor decision. |
| Source modules already contain dense lifecycle logic | Extraction could create files over repository size limits or shallow wrappers | Design deep stage modules with bounded interfaces and audit every source file over 1,000 lines during migration. |

## Non-Goals

- Make pi-plan-mode call an installed pi-goal extension through package-specific events, commands,
  tools, settings, or persisted state.
- Make pi-workflow import, invoke, inspect, or require pi-plan-mode or pi-goal.
- Duplicate Plan and Goal engines inside pi-workflow or keep separate engines behind a transport-only
  broker.
- Reimplement Pi's agent loop, tool executor, message queues, session JSONL/tree, compactor, provider
  retry, generic process RPC, or extension UI protocol.
- Claim that a workflow event-bus adapter adds native custom commands to `pi --mode rpc`, or ship a
  second JSONL process server without a separately approved product requirement.
- Move product-specific commands, menus, settings UI, wording, icons, channel names, access settings,
  or compatibility aliases into the engine.
- Build an arbitrary workflow DSL, CI/CD engine, cron service, distributed scheduler, or unrestricted
  parallel DAG executor.
- Infer completion from idle state, assistant prose, `agent_end`, or `agent_settled`.
- Publish packages, change npm visibility, create tags, or dispatch release workflows without
  separate explicit approval.

## Assumptions and Unknowns

- The selected package name and shared-engine direction are approved; exact public API names and
  module boundaries remain proposed.
- “All logic” means all reusable workflow-domain lifecycle and stage behavior. Pi remains the owner of
  execution, physical persistence, compaction, retry, generic RPC, and UI transport; product
  interaction surfaces and compatibility names remain in thin extension adapters.
- A dedicated Workflow RPC is not part of the current engine or pi-workflow delivery scope. It may be
  reconsidered only after a concrete consumer establishes the caller, process boundary, operations,
  transport, ownership, and recovery requirements.
- `packages/pi-workflow` is an approved stable combined product and no longer shows a package-level experimental warning.
- pi-plan-mode remains focused on planning and retains its existing ordinary implementation handoff;
  it does not become a second complete Plan-to-Execution product.
- It is unknown whether overlapping `/workflow`, `/goal`, and `/plan` runs should be rejected globally
  or serialized. Phase 5 requires an explicit decision and verification.
- It is unknown whether pi-workflow should become the primary successor or remain a stable third option.
  No predecessor deprecation is implied without separate evidence and approval.
- Broader workflows are deferred beyond this roadmap until concrete consumer demand proves reusable
  stage semantics.
- No delivery dates, owners, staffing assumptions, publication schedule, or release commitment were
  provided.

## Decisions and Changes

- **2026-08-03 — Select the package name:** Use `@narumitw/pi-workflow-engine`; `engine` reflects that
  the package owns workflow state machines and stage behavior rather than only hosting an execution
  environment.
- **2026-08-03 — Choose a shared engine, not a provider broker:** Move reusable Plan and Goal workflow
  logic into the engine. Focused and combined products consume it as thin adapters rather than
  coordinating extension packages.
- **2026-08-03 — Add a standalone combined product:** Build `packages/pi-workflow` in Phase 2 from
  planning and managed-execution stages, then migrate pi-goal and pi-plan-mode in Phases 3 and 4.
  pi-plan-mode remains focused rather than becoming another complete Plan-to-Execution product.
- **2026-08-03 — Defer successor selection:** Keep pi-plan-mode and pi-goal active while pi-workflow
  soaks; decide its primary-successor, coexistence, or continued-experiment role only in Phase 5.
- **2026-08-03 — Treat Pi as the execution substrate:** Reuse Pi's agent loop, tools, queues, session
  tree, compaction, retry, generic RPC, extension UI, and lifecycle events. The engine owns only the
  workflow-domain state, policy, artifacts, restoration, and transitions layered above them.
- **2026-08-03 — Initially prefer headless-first, transport-neutral control:** The original direction
  proposed complete typed workflow operations and events while avoiding claims of native
  `pi --mode rpc` extensibility.
- **2026-08-13 — Defer new pi-workflow RPC:** No current repository consumer proves enough value to
  justify a public automation contract. Keep one clean internal workflow service, preserve the
  existing pi-goal managed-run contract only as compatibility behavior, and reconsider a Workflow
  RPC adapter after concrete consumer and transport evidence receives a separate approved proposal.
- **2026-08-20 — Promote pi-workflow to stable:** Treat the combined extension as a stable third option, remove its package-level experimental warning, and keep pi-plan-mode and pi-goal active pending any separate successor decision.
- **2026-08-03 — Reuse supervision lessons without reviving stale channels:** Carry forward PR #464's
  provenance, exact ownership, structured replies, timeout fallback, and real-consumer gates. Defer
  blocked review and continuation leases, and do not restore removed `pi-goal:rpc:*` channels.
