# 🧑‍🤝‍🧑 pi-subagents — Delegate Work to Specialized Agents

[![npm](https://img.shields.io/npm/v/@narumitw/pi-subagents)](https://www.npmjs.com/package/@narumitw/pi-subagents) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Delegate bounded research or implementation work to isolated specialist agents while the main Pi agent retains planning, integration, verification, and the final answer.

Use the built-in `explorer` for read-only evidence and `worker` for a clearly owned implementation slice.

The compatibility default exposes background and blocking methods, while **Keep Pi available (async)** is an optional smaller background-only surface.

## ✨ Features

- Provides blocking batches, detached reusable agents, read-only consultation, metadata inspection, and queue-only mailboxes.
- Includes `explorer` and `worker` definitions and loads optional user or confirmed project agents.
- Keeps detached agents addressable by durable IDs and task paths across follow-ups and recovery.
- Supports subprocess, in-process, RPC, and deterministic automatic transport choices for different trust and tool needs.
- Applies trust-aware cwd policy, capability contracts, dependency workflows, context bounds, deadlines, turn limits, tool limits, and deterministic termination.
- Persists accepted lifecycle and workflow state, preserves evidence and dissent, and rejects stale work after semantic or session changes.
- Routes nested completion and peer communication through authenticated session-scoped channels.
- Provides `/subagents` settings, status, help, tool-surface selection, and recovery diagnostics.
- Returns concise model-visible results with complete bounded details and sanitized terminal rendering.
- Optionally records content-free local lifecycle and timing events for evaluating delegation behavior.
- Loads a generated split runtime while preserving lazy execution, UI, inspection, and transport chunks.

## 📦 Install

```bash
pi install npm:@narumitw/pi-subagents
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-subagents
```

Build and try this package locally from the repository root:

```bash
npm --workspace @narumitw/pi-subagents run build
pi -e ./packages/pi-subagents
```

The published package declares `dist/index.ts`, so an unbuilt local checkout must run the build before Pi loads the package directory.
An unbuilt checkout intentionally has no declared generated entrypoint.

## 🚀 Quick start

Run `/subagents`, choose **How subagents run**, and review the tools registered by each workflow.

The compatibility default includes background agents and blocking compatibility methods.

Select **Keep Pi available (async)** to register `subagent_spawn`, `subagent_send`, `subagent_manage`, `subagent_mailbox`, and `subagent_inspect` without the blocking methods.

Confirm any change and reload to apply it.

Default `next-turn` delivery is for work the current response does not require.
When the final answer depends on background work, use `/subagents settings` → **Completion and privacy** to select **Continue automatically when work finishes**.
That mode steers completions into active parent work before its next model call, or wakes an idle parent once when no user or extension input is pending.

**Background plus compatibility methods (async + sync)** also provides the deprecated blocking `subagent`, supported `subagent_await` join, and synchronous read-only `subagent_consult`.
The blocking `subagent` tool is deprecated for new work.

Background delegation still requires useful parallel main-agent work, clear worker ownership, and a supported completion path.

## 💬 Commands

- `/subagents` opens the current-session manager in TUI mode and reports bounded status in RPC mode.
- `/subagents settings` opens the same grouped settings hub used by the main menu.
- `/subagents status` shows detailed current-session and configured diagnostics with their sources.
- `/subagents help` explains first steps, settings behavior, commands, and safety limits.

## ⚙️ Settings

Use `/subagents settings` for **Folders and trusted resources**, **Completion and privacy**, **Agent defaults**, and **Advanced runtime settings**.
Use `/subagents` → **How subagents run** to change the registered delegation tools.
Settings are stored in `~/.pi/agent/pi-subagents.json`; the detailed sections below document precedence, reload requirements, and safety behavior.

## 📊 Local usage recording

Local usage recording is disabled by default and creates no usage storage until the user selects **On · local only** in `/subagents settings`.
The setting applies immediately and persists as `usageRecording.enabled` in the user settings file.
No network connection, upload, remote identifier, or project attribution is used.

Records are stored below `<pi-agent-directory>/pi-subagents-usage/` as private per-runtime JSONL writer files.
Directories use mode `0700` and files use mode `0600` on POSIX systems.
Each event is versioned, bounded to 8 KiB, and ends with a newline so a crash-truncated final frame can be distinguished from completed records.
Concurrent Pi processes use separate opaque writer files and never append to one shared file.
Validated writer files older than 30 days are removed after recording starts.
Disabling recording stops new events immediately; existing files remain until the retention window expires or the user removes the directory while Pi is stopped.

Stored fields are limited to extension-generated runtime, session, turn, tool, child, run, and completion ordinals; the effective delegation surface; lifecycle and typed outcome states; bounded executor-owned termination reasons; runtime-versus-explicit budget-source labels; completion-delivery transitions; bounded usage numbers; errors as booleans; and monotonic timing or durations.
The recorder does not store prompts, delegated tasks, responses, thinking, tool arguments or results, code, paths, commands, mailbox or steering content, raw errors, provider/model identity, credentials, Pi session identifiers, or a persistent device identifier.
Raw child, run, completion, and provider tool-call identifiers are replaced with runtime-local ordinals before publication.

The events can describe blocking versus async tool selection, operational errors, parent/child overlap, child terminal states, completion attempts and visibility, turns, tokens, and wall-clock durations within one runtime.
They cannot establish semantic task success, whether delegation was appropriate, whether parent work was useful, or whether a completion was understood by the model.
Opt-in field data describes only users who enabled recording and does not prove causal effects between tool surfaces.
Use a controlled benchmark before interpreting future `subagent_await` immediate-join or blocking-choice hypotheses causally.

`/subagents status` reports whether recording is active, the current-session event count, retention, and the local path.
A failed write drops that event, reports one bounded warning, and retries on later events without exposing filesystem details.

## 🛠️ Tools

`pi-subagents` registers eight tools by default.
Run `/subagents`, choose **How subagents run**, review the concrete tool changes, then select **Save and reload** to apply one of these workflows:

| Workflow | Registered tools |
| --- | --- |
| **Background plus compatibility methods (async + sync)** (compatibility default) | `subagent`, `subagent_spawn`, `subagent_send`, `subagent_await`, `subagent_manage`, `subagent_mailbox`, `subagent_inspect`, and `subagent_consult` |
| **Keep Pi available (async)** | `subagent_spawn`, `subagent_send`, `subagent_manage`, `subagent_mailbox`, and `subagent_inspect` |
| **Compatibility blocking methods (sync)** | `subagent`, `subagent_inspect`, and `subagent_consult` |
| **Subagents disabled** | `subagent_inspect` only; delegation is disabled |

`subagent` is deprecated for new work but remains registered in compatibility workflows with its existing schema and execution behavior.
No removal release or date is currently set because chain, fan-in, panel, and explicit workflow callers do not yet have one-for-one detached replacements.
`subagent_consult` and `subagent_await` remain supported and are not deprecated.
The four async lifecycle tools stay separate because starting work, sending follow-ups, managing lifecycle, and queueing mailbox messages have different contracts.
`subagent_await` is a separate blocking join and is omitted from **Keep Pi available (async)**.
Any default change, tool removal, or lifecycle consolidation requires a separately approved compatibility migration.

The preview compares the selection with the tools registered in the current session, even when a manual settings edit is pending, and remains read-only until confirmation.
Escape or **Cancel** leaves settings unchanged.
Tool removal requires an extension reload because Pi does not expose extension tool unregistration.
To avoid aborting work or removing isolated worktrees during `session_shutdown`, workflow changes are blocked while background agents are saved for follow-up; finish or clear them through **Current subagents** first.
Pi owns reload-error reporting and does not return a success result to extensions, so the save notification also tells users to run `/reload` if the tool surface does not refresh.

The available tools are:

- `subagent` — deprecated compatibility tool for blocking single, parallel, fan-in, chained, panel-review, or explicit dependency-workflow calls.
  Existing callers remain supported, but new work should prefer the main agent, detached lifecycle tools, or `subagent_consult` according to the task.
  The main agent cannot process queued steering until the call returns.
- `subagent_spawn` and related lifecycle tools — when enabled, start reusable detached work, return immediately, and receive bounded completion messages automatically.
- `subagent_await` — intentionally block until one retained turn settles or its independent wait timeout expires; timeout and cancellation never interrupt the child.
- `subagent_inspect` — inspect agent/model/run/runtime metadata without launching work or changing state.
- `subagent_consult` — run one ephemeral read-only consultation and wait for its answer.

### Interactive tool rows

In Pi's interactive TUI, every registered tool uses Pi's native tool shell and theme.
Call rows identify the action, agent or retained id, scope, and a bounded task/message preview.
Result rows use explicit `Starting`, `Running`, `Completed`, `Failed`, `Cancelled`, `Interrupted`, or `Closed` text in addition to icons and color.

Collapsed rows stay scan-friendly: consultation and blocking calls show recent activity while running, completed answers show up to three lines, and list actions show up to five items.
Use Pi's configured `app.tools.expand` keybinding (Ctrl+O by default) for the additional bounded task, policy, activity, answer, usage, inspection, or mailbox details available to that tool.
The hint follows the user's keybinding rather than assuming Ctrl+O.

`subagent_consult` emits an initial starting update before launching its child and then reports the actual provider/model, thinking request, usage, and a safe projection of recent `read`, `grep`, `find`, and `ls` activity.
Progress never includes full child messages, prompts, credentials, headers, or environment values.
Tool-row previews remove terminal controls and redact private text.

`subagent_spawn` remains deliberately detached and non-polling: its tool row ends after returning the new `agentId` and initial retained state.
It does not pretend to stream the background child after the tool call has completed; the existing completion message and configured delivery policy report eventual completion.

Custom transcript rendering is TUI presentation only.
Tool names, parameter schemas, model-facing final content/details, errors, completion delivery, and print/JSON/RPC final output remain unchanged; JSON/RPC observers may see additive bounded consultation partial-progress details.

After each session starts, one hidden versioned `pi-subagents` session-guidance message publishes the bounded parent-facing catalog and effective non-secret delegation policies.
Entries show the source (`built-in`, `user`, or `project`), required `agentScope`, declared capability identifiers, configured tools, filesystem authority, and supported result formats; the `agent` parameters remain unconstrained strings for cwd and scope flexibility.
The catalog also warns that enforced path, network, and secret guarantees are unsupported.
It is rebuilt on `/reload` or the next session start, and omitted entries are reported explicitly when the catalog exceeds its metadata bounds.
The registered tool descriptions, schemas, and prompt metadata remain stable until a reload changes the configured tool surface.

Choose the API by lifecycle:

| Need | Use |
| --- | --- |
| One simple, tightly coupled, or immediate critical-path task | Keep it in the main agent |
| Ordinary planning or review | Use the main agent with applicable skills and deterministic checks |
| One bounded implementation slice can run beside named main-agent work | Use async `subagent_spawn` with `worker`, clear ownership, and a supported delivery and integration path |
| Two or more independent implementation slices | Use workers with disjoint write ownership while the main agent coordinates and integrates |
| Broad read-only evidence that can run beside main-agent work | Use async `subagent_spawn` with `explorer` |
| Final-answer-dependent detached work | Enable `completionDelivery: "auto-resume"` so active work receives completion by steering and an idle parent can start a synthesis turn |
| Bounded synchronous read-only evidence whose independent perspective justifies waiting | Use `subagent_consult` when blocking delegation is enabled |
| Existing synchronous workflow, panel, chain, or fan-in caller without a detached replacement | Keep deprecated `subagent` as a compatibility route |
| Reusable history, follow-ups, or mailboxes | Use `subagent_spawn` and lifecycle tools when enabled |
| One retained result is now required and useful overlapping parent work is complete | Use `subagent_await` when blocking delegation is enabled |
| Side-effect-free agent/model/run diagnostics | Use `subagent_inspect` |

Execution modes:

- **single** — run one `{ agent, task }` job.
- **parallel** — run multiple `{ agent, task }` jobs independently.
- **parallel + aggregator** — run parallel jobs, then pass all outputs into one fan-in agent.
- **chain** — run sequential steps, passing prior output with `{previous}`.
- **workflow** — run named tasks only after declared `dependsOn` tasks and required `inputArtifacts` are ready; independent conflict-free tasks may run concurrently.
- **panel** — run at least two independent reviewers over one shared task and snapshot, then run one synthesizer only when `minValidReviews` valid evidence artifacts remain.

Common controls:

- `cwd` — choose a launch directory subject to the user-owned trust-aware target policy described below.
- `timeoutMs` — choose the per-turn work deadline for the task difficulty.
- `totalTimeoutMs` — cap an entire blocking single, parallel, chain, panel, or fan-in workflow, including queued work and reserved panel phases.
- `idleTimeoutMs` — stop work that produces no completed assistant turn or tool result within the selected interval.
- `maxTurns` / `maxToolCalls` — stop unfinished repeated work after bounded assistant turns or tool calls.
- `thinkingLevel` — request `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` thinking for the spawned Pi process or retained child.
- `idempotencyKey` — make an exact `subagent_spawn` retry return the existing retained `agentId`; reuse with different parameters fails before confirmation, worktree creation, or child launch.
- `resultFormat` — keep bounded text by default, request legacy `structured-v1`, or request `structured-v2` with explicit outcome status, reason code, claims, artifacts, verification, limitations, and unresolved dependencies.
- `completionRequirement` — mark one detached spawn or follow-up as `background` (default) or `required` for the parent final answer; required mode tracks the accepted run ID and generation until its exact completion is visible or terminal.
- `totalTimeoutMs` — bound a whole explicit blocking workflow; no new task starts after the budget is exhausted.

For `subagent_spawn`, the root agent selects the lowest thinking level and shortest realistic work deadline sufficient for the delegated task.
These are tool-argument decisions made from the task already in context; `pi-subagents` does not run a string heuristic or an extra classifier model call.

## 🔐 Working-directory trust policy

Pi records saved project trust in `~/.pi/agent/trust.json`.
The closest saved decision for the canonical target or one of its parents wins, so trusting a worktree parent covers worktrees below it while a nearer `false` overrides a trusted parent.
`pi-subagents` reads this through Pi's public `ProjectTrustStore`; it never parses, writes, or migrates the file.
Open Pi in a folder and use `/trust` to manage trust, then restart Pi before expecting retained-runtime behavior to change.

The default target policies are:

| Setting | Values | Default behavior |
| --- | --- | --- |
| `cwdPolicy.consultation` | `"anywhere"`, `"current-workspace"` | `"anywhere"`: consultation may start in any existing directory, but a target without effective trust is forced to `resources: "none"` |
| `cwdPolicy.delegation` | `"trusted-targets"`, `"current-workspace"`, `"anywhere"` | `"trusted-targets"`: blocking and detached delegation may target the current workspace or an external folder covered by a saved `true` decision |

All paths are resolved relative to the current session workspace and canonicalized before containment and trust checks.
Missing paths, non-directories, sibling paths, and symlink escapes cannot bypass the policy.
Blocking parallel, chain, panel, and fan-in calls preflight every target before any child starts.
A generated `workspaceMode: "worktree"` inherits the resolved trust of its approved base cwd.

`"anywhere"` for general delegation restores the previous external-target flexibility.
An external target without effective trust starts with `projectTrusted: false`, so Pi-protected project settings, packages, extensions, skills, prompts, and system resources stay disabled.
General agents still have their configured tools and ordinary Pi/OS permissions, and Pi may still load `AGENTS.md` or `CLAUDE.md` because those context files are not protected by project trust.
Resource-free consultation is stricter: it also passes `--no-context-files`, `--no-skills`, `--no-prompt-templates`, `--no-approve`, and `--no-extensions`.

These controls govern child starting directories and automatically loaded resources.
They do **not** restrict absolute paths, shell commands, custom tools, network access, extension code, or filesystem access available to the Pi process.
For real isolation, run Pi in a container, VM, micro-VM, or OS sandbox with only the required paths and credentials mounted.

## 🧭 Proactive use

When registered, deprecated `subagent` advertises its migration paths and limits compatibility use to existing callers or explicit requests whose orchestration semantics lack a detached replacement.
When stateful lifecycle tools are registered, stable `subagent_spawn` metadata explains both delivery modes and the session-guidance message identifies the active completion policy.
Changing a live policy through `/subagents settings` appends a superseding session-guidance message for the next turn without starting a model turn.

The current session-guidance message advertises the agent catalog automatically, so no preliminary list call is needed.
Each entry exposes the exact declared capability and tool identifiers needed by an enforced contract, plus filesystem authority and result formats.
Agents without a valid capability manifest are labeled `undeclared` instead of implying support.
Built-ins and user agents appear under the default `agentScope: "user"`.
Trusted project agents appear separately and explicitly require `agentScope: "project"` or `"both"`; project-authored names and descriptions are not read into metadata for untrusted projects.
If a project definition shares a name with a user or built-in definition, the user version is the default and the project version is used only for `"project"`/`"both"`.
A user override of a built-in also shows the built-in fallback available with `agentScope: "project"`; `"both"` keeps the user definition.
The catalog is bounded and reports its omission count; metadata discovery also caps files and bytes read per scope.
Each newer session-guidance message explicitly supersedes earlier guidance while preserving the existing conversation prefix.

Delegation guidance:

- The main agent owns overall planning, immediate critical-path work, integration, final verification, and the final answer.
- Use **no subagent** for simple answers, quick targeted edits, latency-sensitive one-step work, tightly coupled work, or the main agent's immediate blocker.
- Before one ordinary `subagent_spawn`, identify useful non-overlapping main-agent work that can start immediately and decide how completion will be integrated.
- A single async `worker` may implement a bounded slice with clear ownership while the main agent advances its named local task.
- If no useful main-agent work exists, perform the single-lane task directly instead of spawning one ordinary worker.
- A single worker without concurrent main-agent work remains available when the user explicitly requests a specialist model, tool profile, or isolation boundary.
- With default `completionDelivery: "next-turn"`, use detached work only when the current response does not depend on its result because an idle root is not awakened.
- With `completionDelivery: "auto-resume"`, detached work may affect the final answer because completion steers into active work or requests a later synthesis turn from idle.
- Mark every final-answer-dependent spawn with `completionRequirement: "required"`, retain its returned ID or path, treat interim output as progress, and synthesize only after every corresponding completion is visible or terminal.
- After `subagent_spawn` returns, immediately continue the identified local task instead of merely announcing the spawn, waiting, polling, duplicating the child task, or ending while useful local work remains.
- Do not duplicate a running child's assigned work; use a bounded parent fallback only after completion reports failure or insufficient evidence.
- Use multiple workers only for truly independent slices with disjoint write ownership and safe workspace concurrency, and keep integration in the main agent.
- Keep ordinary planning in the main agent or express a genuine dependency graph through an explicit caller-authored `workflow` payload.
- Keep ordinary review in the main agent with a review skill and deterministic checks; reserve custom verifier agents or panels for consequential independent verification.
- Do not choose deprecated `subagent` for new work; retain it only for an existing caller or an explicit request whose chain, fan-in, panel, or workflow semantics lack a detached replacement.
- Do not use project-local agents unless the user explicitly opts into them with `agentScope: "project"` or `"both"`; keep confirmation enabled for untrusted repositories.

Examples where the main agent chooses the topology:

No subagent for a known-file edit:

```txt
Rename one symbol in src/foo.ts.
```

One async implementation worker beside useful main-agent work:

The following example assumes `completionDelivery: "auto-resume"` because the final answer depends on both slices.
The main agent owns `src/parser.ts`, immediately continues that work after spawn, and later integrates and verifies the worker result.

```json
{
  "agent": "worker",
  "task": "Implement the approved formatter slice only in src/formatter.ts and test/formatter.test.ts. Do not edit src/parser.ts. Report changed paths, checks, and remaining risks.",
  "completionRequirement": "required"
}
```

For two or more implementation workers, issue one spawn per disjoint slice, state each file or responsibility boundary, and keep integration in the main agent.
Shared-workspace agents may write concurrently by default; use isolated worktrees when repository-write isolation is required.

A blocking fan-out is reserved for output that must be synthesized before the main agent continues:

```json
{
  "tasks": [
    {
      "agent": "explorer",
      "task": "Research auth-related source files. Report paths and open questions. Do not edit files."
    },
    {
      "agent": "explorer",
      "task": "Research auth-related tests. Report coverage gaps. Do not edit files."
    }
  ],
  "aggregator": {
    "agent": "explorer",
    "task": "Merge these findings into a concise implementation-risk summary. Use {previous}."
  }
}
```

## 🔎 Read-only inspection

`subagent_inspect` is registered in every workflow, including disabled delegation.
It never starts a child, sends or acknowledges mailbox messages, interrupts or closes a run, changes settings, refreshes providers, resolves credentials, or modifies files.

| Action | Parameters | Result |
| --- | --- | --- |
| `list_agents` | Optional `agentScope` (default `user`) and `limit` (default 32, maximum 100) | Bounded agent metadata and omission counts |
| `get_agent` | Required `agent`; optional `agentScope` | One resolved definition, safe source path, configured tools, and consultation-effective tools; never the system prompt |
| `list_runs` | Optional `includeClosed` and `limit` (default 50, maximum 100) | Metadata-only retained-run summaries, turn generation, pending-completion count, and unread counts |
| `get_run` | Required `agentId` | Safe `cwd`, current run and turn generation, current-task/error summaries, thinking level, context footprint, protocol, effective transport, bounded timing/usage telemetry, structured result when valid, policy, history count, pending-completion count, and unread count |
| `list_workflows` | Optional `limit` (default 50, maximum 100) | Metadata-only persisted blocking-workflow summaries for the current session |
| `get_workflow` | Required `workflowId` | Bounded task states, generations, dependencies, plan identities, artifact metadata, verification state, and outcome reasons without artifact contents |
| `list_models` | Optional `limit` (default 50, maximum 100) | Session-scoped models, or the already-loaded available snapshot |
| `preview_context` | Optional `context` and `contextEntryIds` | Selected mode, user turns, source count, UTF-8 bytes, and truncation without returning context text |
| `status` | No additional fields | Effective workflow, runtime counts/transport, detached limit values, completion delivery, local usage-recording state, consultation resources, and configured/runtime settings with per-field sources |
| `diagnose` | No additional fields | Structured `pass`, `warning`, and `fail` checks; failed checks are report data rather than a tool error |

The schema rejects fields that do not belong to the selected action.
Explicit `project` or `both` scope fails before project-agent discovery unless Pi already trusts the project.
Run inspection never returns history output, stored context, or mailbox content; unread counts come from a metadata-only snapshot and do not acknowledge messages.
Workflow inspection reads validated, redacted snapshots without quarantining or rewriting invalid files.
Paths beneath the Pi agent directory use `~`, project paths are workspace-relative, model objects are projected through an allow-list, and model-facing text is bounded to 50 KiB or 2,000 lines.

`subagent_manage` no longer accepts its former compatibility `list` action.
Use `subagent_inspect({ "action": "list_runs", "includeClosed": true })` for metadata-only discovery and `get_run` for detail.

## 📖 Read-only consultation

Ordinary planning and review stay in the main agent with applicable skills and deterministic checks.
Use `subagent_consult` only when bounded read-only evidence and an independent perspective justify making the main agent wait.
It is registered whenever blocking delegation is enabled and runs exactly one synchronous, non-retained child with `--no-session`, `--no-extensions`, and only the effective intersection of the agent tools with `read`, `grep`, `find`, and `ls`.
A missing tool list receives those four defaults, while an explicit `tools: []` receives `--no-tools`.
Write, shell, lifecycle, custom, and extension tools cannot enter the child allow-list.
The executor policy remains authoritative even when the task or agent prompt asks for implementation.

```json
{
  "agent": "explorer",
  "task": "Inspect the authentication changes and report correctness and security findings with paths.",
  "thinkingLevel": "high"
}
```

The actionless schema requires `agent` and `task` and accepts optional `agentScope`, `confirmProjectAgents`, `cwd`, `timeoutMs`, and `thinkingLevel`.
Any agent resolved from that scope may be selected; consultation always intersects its configured tools with the enforced read-only allow-list rather than defining a separate read-only agent category.
An unknown name fails before launch with a bounded name/source list for the requested scope.
Project scope is rejected before discovery when the project is untrusted.
A trusted project agent still asks for confirmation by default; non-interactive calls fail closed unless they explicitly send `confirmProjectAgents: false`.
Declining an interactive confirmation returns a normal cancelled result without launching or charging a child.

`consult.resources` controls automatically inherited instruction resources:

| Value | Behavior |
| --- | --- |
| `"project-context"` (default) | Keep ordinary user context/system files and trusted project `AGENTS.md`, `CLAUDE.md`, `SYSTEM.md`, and `APPEND_SYSTEM.md`; disable skills and prompt templates |
| `"none"` | Use only the package consultation base, selected agent prompt, and enforced read-only instruction |
| `"all"` | Keep ordinarily discoverable trusted context/system/append-system files, skills, and prompt templates |

Extensions remain disabled for all three values.
Pi core owns system-prompt source precedence: a trusted project prompt wins over the global prompt, with the global prompt used as fallback.
A selected Pi prompt source must be a readable regular file; directories, FIFOs, devices, sockets, and unreadable sources fail before child launch.
A current target uses the session's effective project trust, including session-only or CLI overrides.
An external target uses the nearest saved trust decision.
For an untrusted, explicitly denied, unsaved, or trust-error target, consultation remains available when `cwdPolicy.consultation` permits it but automatically downgrades to `resources: "none"`.
This also disables context files because Pi does not protect `AGENTS.md` and `CLAUDE.md` with project trust alone.
A saved-trusted external target uses the configured resource policy and discovers `SYSTEM.md`, `APPEND_SYSTEM.md`, and ordinary child context from that target rather than the parent workspace.

Both settings are user-owned in `~/.pi/agent/pi-subagents.json`; projects cannot override them.
`cwdPolicy.consultation: "current-workspace"` rejects every canonical external target before agent discovery or launch even when that target is saved-trusted.
This is not a path sandbox: read-only tools can still read an explicitly requested accessible absolute path.

Result details report the canonical safe cwd, current/external boundary, bounded target-trust decision/source/warning, requested and effective tools/resources, downgrade reason, agent/model/thinking/timeout metadata, and the facts that extensions, session persistence, and retained-agent state are disabled.
They never dump prompt contents or the full trust store.
Nested model usage is returned through Pi's usage field, so footer, `/session`, and RPC totals include consultation cost.
Validation, disallowed targets, and launch failures throw.
Failures after model launch preserve bounded partial evidence and usage while the finalized Pi tool result is marked as an error.
Explicit abort, session replacement, and shutdown use the existing process-tree termination and temporary-file cleanup path; a work timeout additionally makes one separately bounded, tool-less summary attempt after abort.

## 🚀 Blocking batch examples

Every example in this section calls `subagent` and keeps the main agent unavailable until the batch finishes.
Use `subagent_spawn` instead when the work can complete asynchronously and its configured completion policy supports when synthesis is needed.

Run one read-only reconnaissance agent:

```json
{
  "agent": "explorer",
  "task": "Find the statusline extension entry points"
}
```

For genuinely random values, specify the range, duplicate policy, and a system randomness source instead of relying on model sampling, for example: `Use Python secrets to return 10 integers from 0 through 999; duplicates are allowed.`

Run multiple agents in parallel with a shared thinking level and one per-task override:

```json
{
  "tasks": [
    {
      "agent": "explorer",
      "task": "Map package metadata files",
      "timeoutMs": 30000,
      "thinkingLevel": "low"
    },
    {
      "agent": "explorer",
      "task": "Inspect TypeScript config consistency"
    }
  ],
  "timeoutMs": 120000,
  "thinkingLevel": "medium"
}
```

Omit `aggregator` entirely when parallel worker outputs should return directly.
Do not send `null`, empty strings, or an empty object for an unused optional field; for compatibility, an aggregator with an empty or whitespace-only `agent` or `task` is treated as absent.

Run parallel workers, then aggregate their results:

```json
{
  "tasks": [
    { "agent": "explorer", "task": "Find auth-related code" },
    { "agent": "explorer", "task": "Find auth-related tests" }
  ],
  "aggregator": {
    "agent": "explorer",
    "task": "Merge, dedupe, and verify these findings. Use {previous}."
  }
}
```

Run a read-only chain where each step receives the previous output:

```json
{
  "chain": [
    { "agent": "explorer", "task": "Find subagent-related code" },
    {
      "agent": "explorer",
      "task": "Summarize the relevant paths and open questions from this inventory: {previous}"
    }
  ]
}
```

Ordinary review stays in the main agent with a review skill and deterministic checks.
Run an evidence-preserving panel only when consequential independent perspectives justify blocking the main agent:

```json
{
  "panel": {
    "id": "auth-panel",
    "preset": "code-review",
    "task": "Review the authentication change for correctness and regressions.",
    "context": "Inspect the current repository snapshot and existing test evidence.",
    "reviewers": [
      { "id": "correctness", "agent": "explorer", "focus": "Control flow and edge cases" },
      { "id": "tests", "agent": "explorer", "focus": "Coverage and regression risk" }
    ],
    "synthesizer": { "agent": "explorer" },
    "minValidReviews": 2
  },
  "totalTimeoutMs": 120000
}
```

Every reviewer receives the same shared task, context, target snapshot, and scope, but never receives sibling output.
Reviewer-specific `focus` text is appended after the shared block.
The executor accepts only strict `pi-subagents:panel-review:v1` artifacts, stamps reviewer provenance, and starts synthesis only after the valid-review barrier.
Agreement is corroboration rather than proof, and a vote cannot clear a correctness, safety, security, or explicit-requirement blocker.
If too few valid reviews remain, the tool returns `insufficient-panel` with bounded partial evidence and failure classes without running synthesis or claiming consensus.
Review, evidence-finalization, synthesis, and cleanup receive explicit phase allocations, and reviewer work cannot consume the synthesis or cleanup reserve.
Only transient launch or transport failures receive one bounded retry; invalid contracts, semantic stalls, permission failures, exhausted budgets, cancellation, and deterministic task failures do not.
Read-only reviewers share the approved target, while conservatively write-capable reviewers receive separate disposable Git worktrees from one clean base.
Worktrees isolate repository writes but do not isolate processes, the network, secrets, credentials, or the rest of the filesystem.
The blocking panel owns every reviewer, synthesizer, timer, generation, transport, and worktree and closes them when the call settles or Pi emits graceful session replacement or shutdown.
An uncatchable host kill or forced process termination cannot guarantee cleanup; inspect `git worktree list`, remove any confirmed generated `pi-subagent-worktree-*` entry, and run `git worktree prune` if the host terminated before Pi dispatched lifecycle cleanup.
Panel WorkItem snapshots persist metadata and artifact references for current-session inspection without storing raw review bodies.

Run an explicit dependency workflow:

```json
{
  "workflow": {
    "id": "auth-review",
    "tasks": [
      {
        "id": "inventory",
        "agent": "explorer",
        "task": "Produce the auth inventory artifact.",
        "resultFormat": "structured-v2",
        "readPaths": ["src/auth"]
      },
      {
        "id": "review",
        "agent": "explorer",
        "task": "Inspect the inventory and report verification evidence.",
        "dependsOn": ["inventory"],
        "inputArtifacts": ["auth-inventory"],
        "resultFormat": "structured-v2"
      }
    ]
  },
  "totalTimeoutMs": 120000
}
```

Managed verified execution is an explicit per-workflow contract.
The verifier examples below assume a custom user agent named `api-reviewer` with `independent-review` capability.
The executor infers the final mutating integration owner when none is declared, synthesizes one distinct read-only verifier, runs declared deterministic checks in a disposable Git worktree overlaid with the submitted state, and accepts only the exact unchanged submitted state.
Every deterministic check has a stable evidence ID, a direct executable with argument-array invocation, and an optional relative `cwd` and timeout.
Only `git`, `node`, `npm`, and `npx` are accepted; shell command strings fail before child allocation.
The integration owner must request `structured-v2`, declare a non-empty `writePaths` scope, and name current required evidence through its delegation contract.
Every required evidence ID must match a currently passed executor-owned check; worker-authored artifact metadata never satisfies that binding.

```json
{
  "workflow": {
    "verifiedExecution": {
      "verifierAgent": "api-reviewer",
      "maxReworkCycles": 1,
      "checks": [
        {
          "id": "focused-test",
          "command": "npm",
          "args": ["test", "--", "feature"],
          "timeoutMs": 120000
        }
      ]
    },
    "tasks": [
      {
        "id": "implementation",
        "agent": "worker",
        "task": "Implement the contracted change.",
        "writePaths": ["src", "test"],
        "acceptanceCriteria": ["The focused regression test passes"],
        "resultFormat": "structured-v2",
        "contract": {
          "version": "pi-subagents:delegation:v2",
          "level": "full",
          "taskId": "implementation",
          "objective": "Implement the contracted change",
          "requiredEvidence": ["focused-test"],
          "sideEffectPolicy": "mutating"
        }
      }
    ]
  }
}
```

An advanced caller may provide the verifier task instead of letting the executor synthesize it.
That task must directly and only depend on the integration owner, use `structured-v2`, select the configured distinct verifier agent, and declare an enforced read-only contract without shell or custom tools.
The executor narrows accepted verifier authority to `read` even when the selected agent normally has broader tools, and disables verifier extensions, skills, prompt templates, and inherited context files.

The older explicit verifier contract remains available as a compatibility gate without managed integration:

```json
{
  "workflow": {
    "tasks": [
      {
        "id": "implementation",
        "agent": "worker",
        "task": "Implement the contracted change.",
        "resultFormat": "structured-v2",
        "contract": {
          "version": "pi-subagents:delegation:v2",
          "level": "full",
          "taskId": "implementation",
          "objective": "Implement the contracted change",
          "admission": {
            "contextPressure": "medium",
            "independentWorkItems": 1,
            "coupling": "dense",
            "verificationRequired": true,
            "verificationAvailable": true,
            "budgetAllowsChildren": true,
            "requirementsComplete": true
          }
        }
      },
      {
        "id": "verification",
        "agent": "api-reviewer",
        "task": "Independently verify the staged result.",
        "dependsOn": ["implementation"],
        "verifierFor": "implementation",
        "resultFormat": "structured-v2"
      }
    ]
  }
}
```

Cycles, missing dependencies, conflicting integration owners, recursive workflow grandchildren, and unsafe retry or hedge policies fail before child launch.
Workflow scheduling starts at most two mutating tasks concurrently, while declared read-only work may use the existing four-child ceiling.
Set `workflow.honorAdmission: true` only when explicit contract admission metadata should be allowed to decline parent-owned or insufficient-evidence work before launch; admission never silently widens the requested architecture.
Workflow result details include the final ledger, scheduling decisions, artifact versions, task generations, attempts, hedge use, accepted plan identity, and bounded capability-grant metadata.
A task that explicitly requires independent verification must have exactly one direct-dependent `verifierFor` task using a different agent, and both tasks must request `structured-v2`.
The producer stops in `awaiting-verification`, its own passing verification claims remain untrusted, and ordinary downstream tasks stay blocked until the executor records an accepted verifier receipt.
The verifier runs alone in a fresh subprocess context against one bounded Git-visible tree identity and must encode `verification-accepted`, `verification-rework`, or `verification-rejected` through the documented `structured-v2` status and reason fields.
Dirty-tree identity covers at most 1 MiB across separately framed staged and unstaged binary diffs plus bounded non-ignored untracked paths and bytes; submodules, unsupported states, and changing trees fail closed.
The compatibility gate preserves bounded rework or rejection evidence but does not replay the producer automatically.

With `verifiedExecution`, execution completion and acceptance are separate `pi-subagents:work-acceptance:v1` states.
A worker's own verification, confidence, prose, consensus, or exit status cannot move `pending` acceptance to `accepted`.
The executor-owned `pi-subagents:verification-receipt:v1` binds both tree captures, patch digest, changed paths, accepted scope, target and verifier generations and `ExecutionPlan` IDs, verifier identity, acceptance criteria, required current evidence, and bounded deterministic check receipts.
Each receipt is capped at 12 KiB, each stored check stream at 2 KiB, and oversized acceptance evidence fails closed rather than expanding tool details.
The verifier receives the original objective, current artifact metadata, immutable tree identity, and executor-owned check output rather than the worker narrative.
Verifier mutation, a stale or replaced generation, a failed or unsafe check, missing evidence, wrong scope, patch, plan, tree, or identity, cancellation, timeout, and unsupported Git state all produce non-success.
One verifier `rework` decision may rotate the worker and verifier generations when `maxReworkCycles` is `1`; prior grants are revoked, prior evidence remains history, only current requirements and findings are added, and a second rejection is terminal.
Crashes, timeouts, cancellation, ambiguous settlement, and drift are never replayed.
The disposable check worktree includes bounded tracked and non-ignored untracked files and is removed after checks.
When the repository has a local `node_modules` directory, the worktree is nested beneath it so normal Node and npm resolution can read the installed dependency tree without copying it.
The worktree isolates repository build output, but it does not make the installed dependency tree read-only and is not an operating-system sandbox for processes, network, secrets, absolute paths, or host credentials.
The accepted state remains the selected shared workspace; no general patch merge or conflict resolver is added.

Omitting `verifiedExecution` preserves prior workflow behavior, including the older explicit verifier gate above.
To downgrade, finish active workflows, remove `verifiedExecution`, and either use the explicit `verifierFor` compatibility form or perform verification in the parent.
Older package versions reject the unknown managed contract rather than silently providing its guarantees.
Explicit workflow transitions are atomically persisted as mode-0600, private-text-redacted snapshots for current-session `list_workflows` and `get_workflow` inspection; in-flight execution or acceptance restores as interrupted non-success, and no prior side effect is automatically resumed.
Legacy v1 and v2 records without acceptance fields retain their prior completed terminal meaning, while v1 self-reported verification flags and artifact trust remain untrusted.

## 🔁 Stateful agents

Stateful lifecycle tools are available by default.
`subagent_spawn` is detached: it schedules work, returns immediately with an opaque `agentId` plus canonical `taskPath`, and later delivers a bounded completion to its intended parent.
Every turn receives an executor-owned `runId`, monotonically increasing agent-local generation, and unique `completionId`.
A caller can set `completionRequirement: "required"` on a spawn or follow-up to bind final-answer dependency state to that exact run and generation.
Required state moves from `pending` to `available` after durable terminal completion and to `visible` only after the intended parent context observes the exact completion ID.
Interruption, close, stale restore, and shutdown terminalize unfinished requirements explicitly instead of silently dropping them.
Tool-result details preserve fork-sensitive requirement evidence, and inspection projects bounded requirement state.
The successful tool handoff and delivered completion messages are the ordinary model-visible source of requirement state.
When a resumed session terminalizes an in-flight required run and the retained transcript still contains its pending handoff, one hidden append-only transition supersedes that stale evidence before the next model turn.
This also covers compacted contexts that retain the handoff.
If leading compaction or branch summaries remove the handoff, one canonical hidden fallback is restored at a fixed boundary immediately after the summaries.
Branch-local boundary metadata preserves that exact fallback across reload and branch navigation.
That restored fallback remains fixed for the summary epoch while later cancellation transitions or completion messages supersede it at the conversation tail.
The runtime rejects a sixty-fifth unresolved required run before acceptance so every unresolved exact identity fits in the bounded parent context.
The terminal completion and recipient are persisted before delivery, simultaneous root completions are batched, and the root broker allows at most one in-flight wake until that parent turn starts.
In TUI mode, completion messages show a compact task and payload summary while collapsed; use the configured tool-output expansion action (`Ctrl+O` by default) to show or hide the complete message globally.

Detached work follows a non-polling policy.
Before one ordinary `subagent_spawn`, identify useful non-overlapping main-agent work that starts immediately and a supported completion integration path.
With default `next-turn` delivery, the current response must not depend on the result because an idle root is not awakened.
With opt-in `auto-resume`, detached work may affect the final answer because completion steers into an active parent before its next model call or requests a synthesis turn from idle.
Mark every final-answer-dependent spawn with `completionRequirement: "required"`, retain its returned ID or path, treat interim output as progress, and synthesize only after every corresponding completion is visible or terminal.
When local work finishes before required children, emit at most one brief progress sentence and end the turn rather than repeating waiting updates or using the requested final format, verdict, or conclusion.
After spawning, immediately continue the identified local task instead of merely announcing the spawn, waiting, polling `subagent_inspect` or `subagent_mailbox`, duplicating the child task, or ending while useful local work remains.
Do not duplicate a running child's assigned work; use a bounded parent fallback only after completion reports failure or insufficient evidence.
Omit `contract` for ordinary `subagent_spawn` calls and use it only when explicit acceptance, authority, evidence, or admission semantics are required.
Enforced `requestedAuthority.capabilities` and `requestedAuthority.tools` can be checked and narrowed, but enforced `readPaths`, `writePaths`, network, and secret guarantees reject before child launch because the executor cannot provide those boundaries.
After that rejection, retry once without the unsupported fields or with audit enforcement only when they were advisory; stop when they represented a required security boundary.
Add another detached agent only for truly independent work with safe workspace concurrency and disjoint write ownership.
When both blocking and stateful delegation are enabled, `subagent_await` may intentionally join one retained turn after useful overlapping parent work is complete.
Its `timeoutMs` defaults to 30 seconds and limits only the wait; timeout or caller cancellation does not interrupt or close the child.
The normal at-least-once completion channel remains active, so the same completion may still arrive after the await result.

A detached `worker` may directly implement a bounded slice with clear ownership while the main agent handles another useful slice and retains integration and final verification.
Without concurrent main-agent work, use one worker only for an explicit user-requested specialist model, tool profile, or isolation boundary.
Simple and immediate critical-path work should stay in the main agent.

`stateful.completionDelivery` controls settled completion delivery:

- `"next-turn"` (default) sends `deliverAs: "steer"` without a turn trigger.
  Pi queues it into an active root's context, while an idle root records it without waking.
- `"auto-resume"` sends completion to an active root with `deliverAs: "steer"` and no turn trigger, so Pi places it after the current assistant turn and before the next model call.
  An idle root with no pending user or extension input receives at most one in-flight synthesis wake; pending input suppresses that wake, and simultaneous idle completions share one turn.

Completion delivery and required-run context make dependencies visible to the model but do not enforce model obedience, rewrite premature assistant output, or provide a hard final-answer barrier.
The supported Pi extension API exposes no hook for buffering assistant deltas before display and no replay-safe steering activity for a cross-mode interruptible join.
`message_end` replacement can repair finalized persistence but cannot retract already displayed streaming output.
The package therefore keeps `subagent_await` as the accurately documented blocking fallback and does not claim an extension-only hard barrier.
The repository protocol note at `docs/async-runtime-protocol.md` records the exact state machine and unavailable core guarantees; this work does not modify or publish Pi core packages.
The bounded persisted completion outbox provides ordered at-least-once delivery across process restart without replaying the child turn.
A top-level completion targets `/root`; a nested completion enters the direct retained parent's mailbox and is not duplicated into the root transcript.
If the direct parent cannot own delivery, routing walks toward the nearest live retained ancestor and uses `/root` only as the final fallback.
An idle parent remains asleep, and inspection exposes its unread and pending-completion counts until a later turn consumes the envelope.
When state must be reduced to its storage bound, persistence drops roots without pending completions first and trims old history rather than discarding an outbox-owned root.
A completion is acknowledged only after the intended recipient context observes its exact `completionId`; an injection that returns synchronously but never reaches context remains pending for retry.
The broker retains a bounded set of recently acknowledged IDs to suppress same-session re-enqueue while keeping memory bounded.
If the process exits after context assembly but before acknowledgement is persisted, the same ID can be delivered again and consumers must deduplicate it.
Auto-resume applies only to `/root`; nested delivery never silently starts the parent.
Transient terminal-persistence failures retry with bounded exponential backoff and keep the run pending; shutdown cancels retry waits and reports a final persistence failure instead of silently resolving unsaved work.

The default `subprocess` transport preserves compatibility: each turn starts a fresh isolated `pi --mode json -p --no-session` child and receives sanitized, bounded history.
Pi loads one generated split TypeScript runtime and registers every Subagents tool and command during startup, but loads blocking execution, manager UI, inspection work, and the selected detached transport implementation only on first use.
Session restoration, pending completion delivery, settings validation, and cleanup ownership remain eager.
A failed first-use code load is reported normally and can be retried.
Set `transport` to `in-process` to retain one public Pi SDK `AgentSession` per stateful `agentId`, avoiding repeated process startup while preserving native child history in memory.
Set it to `rpc` to retain one `pi --mode rpc --no-session --no-extensions` process per active retained agent, preserving native child history with a separate process boundary.
Set it to `auto` for deterministic preflight selection: read-only built-in tools use in-process, write-capable built-in tools use RPC, and extension/custom tools use subprocess.
Automatic selection never falls back after child creation or prompt acceptance.

Run `/subagents` in TUI mode to open the standard primary manager.
It leads with how subagents run, what Pi does when work finishes, and counts of working subagents and subagents saved for follow-up.
**How subagents run**, **Current subagents**, **Settings**, **Diagnostics**, and **Help** are the only top-level actions.
**Settings** groups **Folders and trusted resources**, **Completion and privacy**, **Agent defaults**, and **Advanced runtime settings** by user task.
**Diagnostics** shows detailed current-session values, configured values, sources, and the settings path.
**Advanced runtime settings** provides optional transport and capacity controls that most users can leave unchanged.
**Agent defaults** groups tool permissions with per-agent model, thinking, and time-limit defaults.
Per-agent defaults preserve tool and context settings, and explicit tool-call values remain authoritative.
The parallel-worker input rejects invalid values without discarding the draft and applies a successful save immediately.
The background-agent limit screen edits saved-subagent capacity, concurrent work, direct children, nested levels, and stored-record capacity.
Detached-limit saves are durable immediately but apply to the runtime after `/reload` or the next Pi session.
Escape returns from a nested screen to a newly refreshed manager, while Ctrl+C closes the full flow.
Exact workflow/reload and project-agent safety confirmations remain extension-owned because they guard live agent and trust-boundary policy rather than ordinary navigation.

The direct routes remain predictable: `/subagents settings` opens the same four settings groups as the manager; `/subagents status` reports detailed current-session runtime values separately from configured values, per-field sources, and path; `/subagents help` explains first steps, reload behavior, commands, and the non-sandbox limitation.
In RPC mode, bare `/subagents` emits the same bounded status through Pi's notification protocol instead of opening a custom TUI.
JSON and print modes do not emit ad hoc command output.
Manual edits use `~/.pi/agent/pi-subagents.json` and take effect after reloading Pi:

```json
{
  "blocking": {
    "enabled": false,
    "maxParallelTasks": 8
  },
  "stateful": {
    "enabled": true,
    "transport": "auto",
    "completionDelivery": "auto-resume",
    "maxAgents": 16,
    "maxActiveTurns": 4,
    "maxDepth": 3,
    "maxChildrenPerAgent": 8,
    "maxMailboxMessages": 100,
    "maxMailboxMessageBytes": 16384,
    "idleTtlMs": 3600000,
    "retentionDays": 30,
    "maxStoredAgents": 50
  },
  "cwdPolicy": {
    "consultation": "anywhere",
    "delegation": "trusted-targets"
  },
  "consult": {
    "resources": "project-context"
  },
  "usageRecording": {
    "enabled": false
  }
}
```

The settings UI patches the raw JSON atomically and preserves unknown fields.
It refuses to overwrite malformed or invalid settings.
Supported Pi writers serialize the latest-document read and same-directory temporary-file rename through `pi-subagents.json.mutation-lock`.
Editors and older extension versions do not participate in that lock, so avoid manual edits while a settings save is in progress.
`blocking.enabled` defaults to `true`, so **Background plus compatibility methods (async + sync)** remains the compatibility default even though `subagent` is deprecated for new work.
Set it to `false` for the **Keep Pi available (async)** workflow.
`blocking.maxParallelTasks` defaults to `8` and accepts positive integers from `1` through `64`.
It limits worker tasks in one blocking parallel call, while execution still starts at most four workers at once and treats an optional aggregator separately.
`stateful.enabled` also defaults to `true`; its existing `false` value remains the blocking-only workflow.
The detached defaults are `maxAgents: 16`, `maxActiveTurns: 4`, `maxChildrenPerAgent: 8`, `maxDepth: 3`, and `maxStoredAgents: 50`.
`maxDepth` accepts zero or a positive safe integer, while the other four detached limits accept positive safe integers.
Use `/subagents settings` → **Advanced runtime settings** → **Background agent limits** to edit them without replacing unknown JSON fields.
The screen shows current-session and configured values separately because changes apply after `/reload`.
It never reloads automatically, because reload can interrupt retained detached work.
Lowering retained, depth, or stored capacity shows a projected recovery warning when current records would be omitted.
Restored parents that already exceed a lowered `maxChildrenPerAgent` remain available, but they cannot gain another child until they fall below the configured limit.
`cwdPolicy.consultation` defaults to `"anywhere"`, `cwdPolicy.delegation` defaults to `"trusted-targets"`, and `consult.resources` defaults to `"project-context"`.
The Settings UI applies a saved live change immediately to subsequent launches and appends a superseding session-guidance message; manual edits take effect on session start or `/reload`.
The UI explicitly states that target/trust settings are not filesystem sandboxing and directs trust changes to Pi `/trust`.
When stateful tools are enabled, their membership and provider-visible definitions stay fixed across spawn, completion, interrupt, close, mailbox, catalog, and live-policy transitions.
Ordinary turns preserve the normalized provider-visible prefix, while a new guidance message or required-completion transition starts an explicit append-only prefix epoch.
Compaction restoration inserts deterministic guidance and requirement fallbacks after leading summaries and retains each restored message for that summary epoch while later tail messages supersede it.
Branch-local session metadata reconstructs those exact historical boundaries after reload and isolates them during tree navigation, including when refreshed settings require a later guidance transition.
These rules preserve cache-eligible prefixes but do not guarantee a provider-reported cache hit.

| Tool | Purpose |
| --- | --- |
| `subagent_spawn` | Start detached work with an optional canonical `taskName`, task-selected thinking and retained timeout, exact-retry `idempotencyKey`, and `text`, `structured-v1`, or `structured-v2` result format; return both `agentId` and `taskPath` immediately and deliver completion asynchronously. |
| `subagent_send` | Send follow-up work with an optional one-turn timeout override and trigger a new turn on a reusable agent; semantic skew requires explicit `revalidate: true`, and shared-workspace concurrency is allowed by default. |
| `subagent_manage` | Use `"interrupt"` to retain an agent after aborting active work or `"close"` to release it; both actions accept optional `subtree`. Use `subagent_inspect` for all list and detail operations. |
| `subagent_mailbox` | Use `action: "send"` for queue-only messages that do not start a turn, or `"read"` to read and optionally acknowledge unread messages. |

The action schemas are flat for provider compatibility and reject parameters that belong to another action.
For example:

```json
{
  "action": "interrupt",
  "agentId": "sa_example",
  "subtree": true
}
```

```json
{
  "action": "send",
  "agentId": "sa_example",
  "message": "Check the API compatibility note before finishing."
}
```

Use **Current subagents** in `/subagents` to inspect the indented agent tree, lifecycle state, unread count, and current task summary, or to confirm clearing subagents saved for follow-up.
Active turns are FIFO-limited by `maxActiveTurns`; excess retained work remains in `starting` state until a slot is available.
`maxAgents` separately bounds running, queued, and idle records.
`maxChildrenPerAgent` bounds direct children, while `maxDepth` counts nested levels below a depth-zero root.
`maxStoredAgents` bounds sanitized records persisted per session and does not increase live runtime capacity.
`parentId` accepts either an opaque ID or canonical path and creates a bounded child relationship; subtree interrupt and close operate child-first.

### Canonical paths and retained peer communication

`agentId` remains the durable compatibility key.
Every live retained record also has a session-scoped path under `/root`, such as `/root/research` or `/root/research/tests`.
Supply `taskName` to choose the final segment.
Segments accept lowercase ASCII letters, digits, and underscores; `root`, `.`, `..`, slashes, empty values, and names longer than 128 characters are rejected.
An omitted name receives a deterministic privacy-safe `agent_<hash>` fallback, including for restored legacy records.
A path must be unique while its record is retained and not closed, and the same path may be reused after close.

Root lifecycle and inspection fields named `agentId` continue to accept opaque IDs and now also resolve absolute canonical paths.
A peer target without a leading slash resolves below the authenticated sender's path, while `/root` and paths beginning with `/root/` are absolute.
Use an opaque ID when addressing historical closed records because a closed path is no longer reserved.

Retained child sessions receive two package-owned tools:

- `subagent_peer_send` queues one bounded message for `/root` or another retained peer and never accepts a sender field.
- `subagent_peer_list` returns only bounded ID, path, agent-name, and lifecycle metadata for the current session.

Messages can cross structural agent trees because one registry is one communication namespace.
A running retained target may receive the persisted envelope through its active transport; an idle target remains asleep and consumes the message on its next turn.
Message IDs and optional deduplication keys make retry at-least-once, so recipients must tolerate seeing the same exact ID again after an acknowledgement persistence failure.
Process children use an authenticated loopback JSONL bridge.
Its random credential is bound to one retained process generation, captured and removed from the child environment before model tools run, never persisted or rendered, and revoked on release, replacement, or shutdown.
The broker bounds frames, connections, handshakes, message text, and response text.
If a transport cannot accept a live push, the durable mailbox remains the fallback rather than starting another turn.

To roll back model guidance or callers, omit `taskName`, keep addressing agents by `agentId`, and avoid the child peer tools.
Older records require no manual migration because missing paths and recipients are reconstructed deterministically under the unchanged state version.

### Migrating from the previous seven-tool lifecycle surface

The five replaced names are intentionally not registered as aliases.
Update explicit prompts and integrations as follows:

| Previous call | Fixed-surface call |
| --- | --- |
| `subagent_list({ includeClosed })` | `subagent_inspect({ action: "list_runs", includeClosed })` |
| `subagent_manage({ action: "list", includeClosed })` | `subagent_inspect({ action: "list_runs", includeClosed })` |
| `subagent_interrupt({ agentId, subtree })` | `subagent_manage({ action: "interrupt", agentId, subtree })` |
| `subagent_close({ agentId, subtree })` | `subagent_manage({ action: "close", agentId, subtree })` |
| `subagent_message({ agentId, message, ... })` | `subagent_mailbox({ action: "send", agentId, message, ... })` |
| `subagent_messages({ agentId, acknowledge, limit })` | `subagent_mailbox({ action: "read", agentId, acknowledge, limit })` |

Persisted agent and mailbox records require no manual migration; older records load with an empty completion outbox and generation zero.
If an explicit prompt in a resumed conversation keeps requesting an old name, update it with the mapping above or start a fresh conversation.
To roll back after an upgrade, pin the package version used before the upgrade; for this migration, use `pi install npm:@narumitw/pi-subagents@0.26.0`.
The previous release can read the same state directory.

A spawn can request a thinking level explicitly:

```json
{
  "agent": "explorer",
  "taskName": "concurrency_analysis",
  "task": "Analyze the cross-package concurrency failure and identify the safest fix",
  "thinkingLevel": "high"
}
```

The requested level and spawn `timeoutMs`, `idleTimeoutMs`, `maxTurns`, and `maxToolCalls` are stored with the stateful agent and remain in effect for all follow-ups and after persisted restore.
The same fields on `subagent_send` override only that follow-up turn.
`subagent_send` does not provide a per-turn thinking override; create a new agent when a later task needs a different level.

An exact retry can use a bounded session-owned idempotency key:

```json
{
  "agent": "worker",
  "taskName": "approved_change",
  "task": "Implement the approved change",
  "idempotencyKey": "approved-change-1"
}
```

The same key and canonical request returns the existing retained `agentId` without another confirmation, worktree, or child.
Reusing the key with different behavior-affecting parameters fails.
Closing the retained record releases the key.

Set `resultFormat: "structured-v1"` to ask for legacy `summary`, `evidence`, `changes`, `verification`, and `risks` fields.
Prefer `resultFormat: "structured-v2"` when orchestration must distinguish `completed`, `partial`, `blocked`, `needs-input`, `failed`, `interrupted`, `abstained`, `stale`, or `contract-invalid` outcomes and consume typed artifact evidence.
The child prompt includes a complete minimum JSON object and item shapes; every displayed top-level field remains required even when its array is empty.
Valid structured data and deterministic recovery classification appear in completion and inspection details, while malformed structured output becomes `contract-invalid` instead of being treated as success.
The executor stamps task generation, cancellation lineage, and accepted `ExecutionPlan` identity after parsing, so model output cannot forge the provenance used for stale-result containment.

`subagent_spawn.context` accepts:

- `"none"` (default) — no parent conversation.
- `"all"` — bounded user/assistant text from the active branch.
- `"summary"` — a bounded earlier-context checkpoint plus recent messages verbatim.
- A positive number — the most recent N user turns and related assistant text.

Use `contextEntryIds` to select exact session entries.
Supplying IDs without `context` implies `context: "all"`; an explicit `context: "none"` still disables parent context.
Stable source IDs are retained so repeated follow-ups do not need to duplicate parent context.
Use `subagent_inspect` with `action: "preview_context"` to inspect selected turns, source count, UTF-8 bytes, and truncation before spawning without returning the context text.
The byte count is not a provider token estimate.

Reasoning, tool results, custom transport messages, and non-text parts are excluded.
Text inside `<private>...</private>` and lines containing `[subagent-private]` are omitted before context, mailbox content, or history is persisted.

Stateful execution uses a transport boundary:

- `subprocess` is the default compatibility and rollback path and starts a fresh child for every turn.
- `in-process` uses only public Pi SDK APIs: `createAgentSessionServices()`, `createAgentSessionFromServices()`, `SessionManager.inMemory()`, and normal session lifecycle methods.
  It isolates conversation/tool selection, not memory or crashes; child failures share the parent Node.js process.
- `rpc` uses strict bounded JSONL over one lazy child process per active retained agent.
  A `get_state` response proves readiness, prompt response means accepted only, and `agent_settled` is the completion boundary after retry or compaction.
- `auto` selects one transport before launch and retains the choice for that agent's runtime lifetime.
  It never retries through another transport after startup or accepted work.
- In-process and RPC child resource loading disables user and project extensions to prevent recursive `pi-subagents` loading and duplicate extension side effects while retaining trust-eligible context/skill resources and the selected agent prompt.
  All transports add only the package-owned peer bridge and its two communication tools; the bridge does not add filesystem, shell, model, network-destination, or user-extension authority.
  The compatibility subprocess path retains its recursion-depth guard and configured execution tools.
  Transports receive the same resolved target-trust boolean through their public SDK or explicit CLI trust controls.
- Agent model strings use Pi core's CLI resolver, including provider/model patterns, fuzzy matching, custom provider model IDs, and `:<thinking>` suffixes.
  Thinking level and built-in tool allow-list overrides are applied when the child is created.
  Parent model/thinking changes are snapshotted for subsequently created children; an existing child keeps its own session configuration.
- Extension/custom tool names are rejected by in-process and RPC v1 before child creation; automatic mode selects `subprocess` for them, and permissions are never silently widened.
- Timeout, parent abort, close, expiry, and session shutdown abort or dispose owned child sessions or process groups.
  A child that does not settle after abort grace is discarded rather than reused.
- RPC progress uses `pi-subagents:v1` metadata and reports only bounded phase, queue, timing, effective model/thinking, and validated usage fields.
  Successive Pi 0.84.2 `message_update.usage` values replace one cumulative in-flight snapshot, while a valid final `message_end.message.usage` remains authoritative.
  Missing or invalid final usage falls back to the latest valid streaming snapshot, and an interrupted attempt is committed before retry or timeout-summary usage is added.
  Usage progress and terminal outcomes therefore retain partial token and total-cost evidence without double counting cumulative updates.
  The `turns` field still counts finalized assistant messages only, not interrupted attempts or tool-result messages.
  Telemetry never exposes raw prompts, assistant content, reasoning, credentials, headers, environment values, or full RPC events.
- A successful RPC prompt response is never treated as completion, and accepted or ambiguously accepted work is never replayed automatically.
- In-process startup failures do not silently retry through subprocesses, preventing duplicate side effects.
  If the loaded Pi core lacks public `createAgentSessionServices()`, `createAgentSessionFromServices()`, or `resolveCliModel()` support, startup fails with an actionable instruction to select `stateful.transport: "subprocess"`.

No private Pi imports, runtime casts, or `ExtensionAPI` monkey-patching are used.
The package uses public Pi root RPC types but owns exact CLI resolution, bounded framing, readiness, stderr, cancellation, and process-group cleanup because the stock client does not provide those package-specific guarantees.
Approval policy, sandbox profile, provider-header hooks, extension state, global scheduling, and parent/child transcript switching are not inherited or provided by in-process or RPC transport.

Write-capable detached agents share the workspace and may run concurrently by default.
Classification remains intentionally conservative for automatic transport selection: an agent with `bash`, `write`, or `edit` is write-capable even when its task prompt says “read only,” because prompt wording is not a filesystem sandbox.
Assign disjoint file or responsibility ownership to concurrent writers and keep integration in the main agent.
Use isolated worktrees when repository-write isolation is required.
The deprecated `allowConcurrentWrites` field remains accepted for compatibility but no longer changes admission behavior.
Use the blocking batch only when synchronous outputs justify making the main agent unavailable.

Set `workspaceMode: "worktree"` to opt into a disposable detached Git worktree; this requires a clean repository and the worktree is removed on close or session shutdown.
The generated path inherits the approved base cwd's trust snapshot.
Retained records mark disposable worktrees explicitly, so they are never restored even if cleanup could not remove the generated directory.
Shared-workspace retained records store an additive bounded target-trust snapshot for transport and inspection parity; session restore canonicalizes the retained cwd and re-resolves current/saved trust rather than blindly trusting the persisted value.
Older records without either field remain readable.

## 📜 Compatibility and failure contract

Existing accepted `subagent` payload shapes remain unchanged.
`subagent_spawn` adds optional `taskName`, `idempotencyKey`, and `resultFormat` fields without changing omitted behavior.
`allowConcurrentWrites` remains accepted by `subagent_spawn` and `subagent_send` as a deprecated no-op so stored or resumed calls remain valid.
Spawn request identity continues to include its submitted value for exact-retry compatibility.
Older releases do not recognize `stateful.transport: "rpc"` or `"auto"`; change the value to `"subprocess"` and reload before downgrading.
Retained records remain transport-neutral, and older readers ignore the additive task identity, completion-recipient, idempotency, and context-footprint fields while the state version remains compatible.
The `tasks` schema now advertises the absolute 64-item safety bound, while the effective `blocking.maxParallelTasks` value may be lower.
The intentional compatibility change is that an external target without saved trust is rejected by the new default `cwdPolicy.delegation: "trusted-targets"`; set the user-owned policy to `"anywhere"` to restore the preceding target flexibility.

| Mode | Ordering | Failure behavior |
| --- | --- | --- |
| Single | One result. | A failed/aborted/timed-out worker is marked as a tool error while preserving bounded details. |
| Chain | Input order. | Stops at the first failed step; completed steps remain in details. |
| Parallel | Input order, up to `blocking.maxParallelTasks` total workers and at most four active children. | Rejects calls above the configured limit; otherwise collects all task results, and partial worker failure does not discard successful results. |
| Parallel + aggregator | Source input order, then aggregator. | The aggregator runs with successful outputs and failure descriptions only when total budget remains; aggregator failure or orchestration expiry marks the tool result as an error. |
| Workflow | Deterministic dependency-ready and critical-path order, with results returned in declared task order. | Invalid graphs fail before launch; blocked or failed dependencies prevent downstream start; bounded retry and hedging require explicit side-effect contracts. |
| Panel | Reviewer declaration order, then at most one synthesizer. | Invalid or failed reviews remain visible; synthesis requires `minValidReviews`; insufficient panels preserve partial evidence without a consensus claim; synthesis contract failure marks the tool result as an error. |

An aggregator whose `agent` or `task` is empty or whitespace-only is treated as absent, so successful parallel outputs remain available instead of being replaced by a malformed fan-in failure.

Blocking work-timeout precedence remains: task/step/aggregator → call → agent setting → `PI_SUBAGENT_TIMEOUT_MS` → 600000 ms, then `totalTimeoutMs` caps the effective remaining time.
Blocking idle, turn, and tool-call precedence is task/step/aggregator → call → omitted.
Stateful budget precedence is the explicit `subagent_send` field for one follow-up → retained `subagent_spawn` field → timeout-only agent/environment fallback where applicable.
Blocking thinking precedence remains: task/step/aggregator → call → agent setting → child default.
Stateful spawn thinking precedence is: `subagent_spawn.thinkingLevel` → agent setting → transport fallback.
Project-agent resolution and confirmation behavior is unchanged after target preflight.
Blocking and retained result/inspection details add bounded target, budget, termination, and effective trust metadata.

## 🤖 Built-in agents

Built-in agents are available without setup and can be overridden by user or project agents with the same name.

| Agent | Purpose | Tools |
| --- | --- | --- |
| `explorer` | Read-only codebase exploration for specific questions. | `read`, `grep`, `find`, `ls` |
| `worker` | Bounded implementation and command execution with clear ownership. | Pi default tools |

Ordinary review stays in the main agent with a review skill and deterministic checks.
Use a custom user or project verifier only when consequential independent verification justifies the added cost and coordination.

Built-in agents inherit the active/default Pi model instead of forcing a provider-specific model alias, which keeps every transport usable across different Pi setups.
The built-in `explorer` defaults to `low` thinking for bounded exploration and intentionally omits `bash` so it remains read-only and preserves the automatic in-process route.
Users who need shell-assisted read-mostly work can define a custom agent, but `bash` makes transport classification conservatively write-capable because prompt wording is not an enforcement boundary.
`worker` inherits thinking unless a caller, frontmatter, or per-agent setting selects one.

## ⚙️ Configure agent tools

Open `/subagents settings`, choose **Agent defaults**, then **Tool permissions** in an interactive Pi session to edit the tools each subagent may use.
Choose **Model, thinking, and time limit** to edit provider-neutral model patterns, thinking levels, and time limits without changing tools.
The standard bounded multi-select keeps a one-save draft: toggles do not write until **Save changes**, Escape leaves the draft without writing, and unavailable configured tool names remain visible and preserved.
In TUI mode, type to fuzzy-search tool names and availability metadata; Save and Discard remain pinned below the matches.
These are user settings stored in `~/.pi/agent/pi-subagents.json` and affect future sessions.

Compatibility: a valid legacy `pi-subagents-config.json` remains readable with a warning and is never modified automatically; rename it to `pi-subagents.json`.
The first subsequent settings save writes the canonical file.
If both files exist, the new filename takes precedence.
A saved `agents.scout` override from earlier releases applies to the renamed built-in `explorer` only when no explicit `agents.explorer` override exists and no custom `scout` agent is available.

- Select an agent, then press Enter or Space to toggle tools.
- Choose **Save changes** to write the draft, choose **Discard draft** to abandon it, or press Esc to return to agent selection without writing.
- Save the default selection to remove a custom override and use the agent defaults again.
- Deselect every tool and save to run that agent with no tools.
  An explicit empty list remains distinct from an absent list; blank `tools:` or `tools: []` in agent frontmatter also means no tools.

Configured tool names that are not currently registered are preserved, so settings for tools from other extension sessions are not silently dropped.

## 🧩 Custom agents

Create markdown agent definitions in either location:

- `~/.pi/agent/agents/*.md` for user agents.
- `.pi/agents/*.md` for project-local agents.

Example:

```markdown
---
name: api-reviewer
description: Review API changes for compatibility and tests
tools: read, grep, find, ls
model: sonnet
thinkingLevel: high
capabilityManifest:
  version: pi-subagents:capabilities:v1
  capabilities: [code-review, evidence-review]
  modalities: [text]
  resultFormats: [text, structured-v2]
  authority:
    filesystem: read
  verificationRoles: [independent-review]
  contextStrengths: [repository]
  costHint: medium
  latencyHint: medium
---

You are an API review subagent. Do not edit files. Check compatibility,
test coverage, and migration risks. Report PASS/FAIL/PARTIAL with evidence.
```

`tools` accepts either the comma-separated form above or a YAML string array such as `tools: [read, grep]`.
An omitted field keeps the agent's default tools; blank, `null`, or `[]` explicitly selects no tools.

`capabilityManifest` is optional for legacy custom agents and never grants authority by itself.
Explicit workflow routing can match declared capabilities, configured tools, filesystem authority, verification roles, and low/medium/high cost or latency hints.
A missing or malformed manifest remains unknown and cannot satisfy a capability-routed task.
The parent-facing session-guidance message exposes contract-relevant catalog declarations before the first delegation decision.
Use those identifiers exactly; enforced `readPaths`, `writePaths`, network, and secret guarantees are currently unsupported and require an external enforcement boundary.
A rejected enforced contract reports both contract repair and stop as recovery choices, but repair is safe only when the unsupported fields were descriptive rather than required protection.

`agentScope` is a top-level tool argument supplied per invocation.
It is not a setting in `~/.pi/agent/pi-subagents.json` and does not belong in agent frontmatter.
The parent-facing session-guidance contract discovers these definitions after session start and labels their source and required scope.
Edit agent files and run `/reload` (or start a new session) to refresh the catalog; there is no live filesystem watcher.
The scope selects which custom agent directories are loaded; built-in agents remain available in every scope:

| `agentScope` | Custom agents loaded |
| --- | --- |
| `"user"` (default) | User agents only. |
| `"project"` | Project-local agents only. |
| `"both"` | User and project-local agents. Project definitions override same-named user definitions. |

For an existing compatibility caller, invoke a project-local agent with the deprecated blocking `subagent` tool:

```json
{
  "agent": "api-reviewer",
  "task": "Review this project's API changes",
  "agentScope": "project"
}
```

Or select the scope when creating a stateful agent with `subagent_spawn`:

```json
{
  "agent": "api-reviewer",
  "task": "Review this project's API changes",
  "agentScope": "project"
}
```

A stateful agent retains the scope selected by `subagent_spawn` for its follow-ups.
Every new blocking `subagent` invocation or `subagent_spawn` call that needs project agents must supply `agentScope: "project"` or `"both"` again.

Project-local agents require a trusted Pi project.
Interactive sessions also ask for confirmation before using them by default.
Passing `confirmProjectAgents: false` as another top-level tool argument skips that confirmation dialog, but it does not bypass the project trust requirement.

## ⏱️ Runtime limits and thinking levels

Every turn can combine main-agent-selected wall-clock, idle, assistant-turn, and tool-call budgets with an extension-owned hard-bounded finalization deadline.

- Set `blocking.maxParallelTasks` in `~/.pi/agent/pi-subagents.json`, or use `/subagents settings` → **Advanced runtime settings** → **Blocking worker limit**, to allow 1 through 64 worker tasks in one blocking parallel call.
- The worker-count limit defaults to 8 and does not change the fixed four-at-a-time execution concurrency.
- Set `timeoutMs` on the top-level blocking call to apply a work deadline to all jobs.
- Set `timeoutMs` on a task, chain step, or aggregator to override it locally.
- Set top-level blocking `totalTimeoutMs` to cap model work across the whole call; each child receives at most the remaining budget, queued work is not started after expiry, fan-in receives only remaining time, and an orchestration-expired child skips model finalization.
  Bounded process-cleanup grace may follow the deadline.
- Set `idleTimeoutMs` to stop a turn that has produced no completed assistant turn or tool result within that interval.
- Set `maxTurns` or `maxToolCalls` to stop unfinished repeated work; a terminal answer at the exact turn limit remains successful.
- Give evidence tasks enough turn and tool-call headroom for discovery, reads, and final synthesis, or omit those optional limits instead of guessing tight values.
- Set spawn budgets as retained defaults, or the same fields on `subagent_send` to override one follow-up turn.
- Top-level blocking turn budgets apply to every job, while a task, chain step, or aggregator can override them locally.
- Choose the shortest realistic budgets for the task difficulty; split an oversized task instead of extending limits merely to compensate for broad scope.
- Valid time values range from 1 to 2,147,483,647 milliseconds, matching the runtime timer limit.
- `maxTurns` and `maxToolCalls` accept integers from 1 through 1,000,000.
- If `timeoutMs` is omitted, the default is the retained or agent setting, then `PI_SUBAGENT_TIMEOUT_MS`, or `600000` milliseconds (10 minutes) when unset; the other new budgets remain opt-in.

Set `thinkingLevel` to request one of Pi's supported levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
Blocking subprocess calls pass the resolved value through `--thinking <level>`.

For `subagent_spawn`, the root agent should choose the lowest sufficient level:

| Level | Appropriate delegated work |
| --- | --- |
| `off` / `minimal` | Extraction, formatting, or mechanical work requiring almost no reasoning. |
| `low` | Straightforward, bounded tasks with direct steps. |
| `medium` | Ordinary multi-step research or implementation. |
| `high` | Complex debugging, design, review, or cross-file analysis. |
| `xhigh` | Highly ambiguous, cross-system, or high-risk analysis. |
| `max` | Exceptional hardest tasks where quality clearly outweighs latency and cost. |

Blocking thinking precedence is: task/chain step/aggregator `thinkingLevel` → top-level `thinkingLevel` → agent default from config or frontmatter → Pi subprocess default.

Stateful spawn precedence is: `subagent_spawn.thinkingLevel` → agent default from settings or frontmatter → model suffix → transport fallback.
Subprocess uses spawned Pi model/default resolution.
In-process delegates configured model parsing to loaded Pi core and then uses the parent thinking snapshot captured at child creation.
RPC passes the selected CLI model and thinking controls before its readiness handshake and reports the effective state returned by Pi.
An explicit spawn value is retained for the agent lifecycle and wins over every fallback.

Omit `thinkingLevel` to preserve existing behavior.
Reported stateful details show the requested level, not a guarantee of the provider's effective value.
Pi still owns model capability clamping; `pi-subagents` does not duplicate capability detection.

When any execution budget expires, the extension aborts the active run first and creates a versioned, bounded, redacted checkpoint containing partial assistant notes, completed tool evidence, changed-file hints, and whether side effects may already have occurred.
After authoritative settlement it may make one concise summary attempt over that checkpoint without replaying the stopped task.
The summary attempt has its own extension-owned model-work deadline of at most 45 seconds, followed only by bounded abort and process-cleanup grace.
Fresh subprocess summaries run with no tools or project resources.
Retained RPC and in-process summaries reuse their child context and are explicitly instructed not to call tools; the current child APIs do not support replacing an existing session's tool set for one turn, so their separate deadline and abort path remain the enforcement boundary.
Before a retained RPC summary starts, validated in-flight usage from the interrupted work attempt is committed so the summary adds to it exactly once.
The deterministic checkpoint remains available when finalization or the provider fails, and results retain exit `124` plus a structured termination reason and finalization status.
When bounded finalization succeeds with non-empty usable output, detached registry state reports a typed `partial` outcome with the exact budget reason instead of collapsing that evidence into an undifferentiated failure.
Malformed required structured output, empty or failed finalization, and transport failure remain non-success.
Partial evidence never satisfies mutating acceptance, required evidence, or independent verification.
Inspection and opt-in content-free telemetry distinguish runtime-owned omitted limits from explicit per-turn limits.
Explicit parent or user abort stops immediately, never starts finalization, and is not mislabeled as a budget stop.

This release does not claim a cooperative soft-wrap-up phase because print-mode subprocess children cannot receive steering while they are running.
It also does not retry budget-stopped work automatically because file or external side effects may already have occurred.

The child event protocol limits each JSON line to 256 KiB.
Captured output uses these defaults:

- final output and fan-in/chain context: 50 KiB;
- stderr: 16 KiB;
- captured messages: 200.

Truncated text includes a `truncated by pi-subagents` marker and details expose `truncated: true`.
Inspection and consultation model-facing content also stops at 2,000 lines, whichever limit is reached first.
`PI_SUBAGENT_MAX_DEPTH` controls nested delegation depth and defaults to 1; child processes receive `PI_SUBAGENT_DEPTH` automatically.

## 📡 Runtime status

Run the offline transport benchmark from the repository root when comparing startup overhead:

```bash
just benchmark-subagents
```

It reports serial median and median absolute deviation for deterministic fake fresh-subprocess and retained-RPC turns plus isolated real Pi RPC readiness, retained commands, in-process session creation, and retained in-process state access without making a provider request.
Queue time starts when the registry accepts work, transport startup starts when execution begins, RPC readiness comes from `get_state`, RPC acceptance comes from the correlated `prompt` response, first activity comes from a bounded lifecycle event, settlement comes from `agent_settled`, and delivery is recorded after the parent accepts the completion message.
Subprocess and in-process timing fields use the nearest public lifecycle boundary and may be coarser than RPC.
Timing and progress are current-session diagnostics and are not persisted.
The benchmark measures transport overhead rather than model latency or output quality.

Preview the paired quality benchmark without making provider requests:

```bash
just benchmark-async-subagents --model provider/model
```

Run three paired trials with isolated sync-only and async-only tool surfaces, fixed model and thinking settings, redacted raw records, and a hard per-trial deadline:

```bash
just benchmark-async-subagents --run --mode quick --model provider/model --output /tmp/subagent-quick.json
```

Use `--mode extended` for ten paired trials before any further sync deprecation decision.
The runner alternates arm order, starts work deadlines only after RPC readiness, runs at most three pairs concurrently, and reports completion coverage, evidence score, premature finals, terminal outcomes, median and P95 latency, and cost when available.
Quick mode targets completion within five minutes under normal provider capacity but reports external timeouts and entitlement failures rather than silently reducing the sample.
Live results remain provider- and model-dependent evidence rather than deterministic CI or proof of causality.
The synchronous `subagent` tool remains available whenever a quality gate fails or detached chain, fan-in, panel, or workflow compatibility is unmatched.

While the `subagent` tool is running, `pi-subagents` publishes compact activity status with `ctx.ui.setStatus("subagents", "...")`.
Any statusline extension that reads Pi's generic extension status API can display it; no package-to-package dependency is required.

## 🔒 Security and privacy

Subagents have separate processes and context windows, but they are **not security sandboxes**.
They run as the same OS user, share the host filesystem and network access, and may conflict if they edit the same files.
Tool allow-lists reduce available Pi tools but do not reduce operating-system permissions.
`subagent_consult` prevents writes through its Pi tool surface and disables extensions, but it can read accessible paths, call the configured model over the network, and incur cost; its instruction-resource policy is not a filesystem or confidentiality boundary.
Panel write-capable reviewers use separate disposable Git worktrees, but those worktrees provide repository-write isolation only.

Every contracted execution records a hashed immutable `ExecutionPlan` and an executor-owned capability grant bound to its task generation, effective tools, issuance time, and expiry.
Interrupt, close, shutdown, replacement, persistence, and restore revoke active grants before signalling work or accepting another generation, and late old-plan results become `stale` diagnostic evidence.

The runner explicitly reports policy continuity in result details:

- inherited: process environment;
- overridden when selected: cwd, model, thinking level, and tool list;
- unsupported guarantees: parent approval policy, sandbox profile, and provider headers.

Treat project-local agent prompts like executable project configuration: only enable them in trusted repositories.
Stateful project agents require Pi's project trust; interactive use also keeps confirmation enabled by default.

Stateful records are stored as versioned mode-0600 JSON under `~/.pi/agent/pi-subagents-state/` (or the configured Pi agent directory).
Explicit blocking-workflow snapshots use separate mode-0600 files under `~/.pi/agent/pi-subagents-workflows/`, retain at most 64 workflows per session for 30 days, and are available only through current-session workflow inspection.
Records contain sanitized logical history, canonical task paths, peer envelopes, and pending recipient metadata, but never process IDs, broker sockets, or communication credentials.
Corrupt or unsupported state is quarantined, completed and actionable terminal outcomes are preserved, in-flight records restore as `interrupted`, and no prior side effect is automatically resumed.
Retained follow-ups compare a privacy-safe hashed semantic snapshot before model work; incompatible resource changes require explicit `revalidate: true`, while unknown snapshot versions fail closed.
Snapshots hash agent manifests, prompts, effective tools, model/thinking, transport, trust, Git tracked and untracked state, and bounded user/project skill and prompt resources without persisting their contents.
A non-Git target has no stable repository generation proof, so each later follow-up requires explicit revalidation.
Count projection keeps complete ancestor chains together when stored or restored limits omit older trees.
Retention and count limits are configurable.
Downgrading is safe: older extension versions ignore this separate state directory; clear **Current subagents** from `/subagents` before downgrade if the histories should be removed.

## 🗂️ Package layout

```txt
packages/pi-subagents/
├── dist/                         # Generated split TypeScript runtime loaded through Pi's Jiti loader
├── docs/
│   ├── async-runtime-protocol.md # Required-run state machine and unavailable core guarantees
│   ├── implementation-notes/     # Current direction, capabilities, and RPC contract
│   └── pi-subagents-diagrams.md  # Maintained architecture and workflow diagrams
├── scripts/
│   └── build-runtime.mjs         # Deterministic bundler and eager-boundary validator
├── src/
│   ├── index.ts                  # Thin authoritative source entrypoint
│   ├── subagents-extension.ts    # Lightweight extension composition and blocking registration
│   ├── subagents.ts              # Backward-compatible public utility exports
│   ├── cached-module-loader.ts   # Retryable first-use code-module cache
│   ├── inspect-registration.ts   # Lightweight inspection tool registration
│   ├── inspect.ts                # First-use side-effect-free metadata inspection
│   ├── consult-registration.ts   # Lightweight consultation tool registration
│   ├── consult.ts                # First-use synchronous read-only consultation
│   ├── consult-policy.ts         # Enforced read-only tool intersection
│   ├── cwd-policy.ts             # Canonical target and saved-trust resolution
│   ├── prompt-resources.ts       # Core-selected SYSTEM and APPEND_SYSTEM resources
│   ├── safe-text.ts              # Shared byte/line/path sanitization
│   ├── stateful-registration.ts  # Detached lifecycle registration and dispatch
│   ├── stateful.ts               # Backward-compatible detached utility exports
│   ├── settings-reader.ts        # Side-effect-free startup settings reads and inspection
│   ├── create-stateful-transport.ts # First-turn selected transport loader
│   ├── rpc-transport.ts          # Persistent strict-JSONL Pi RPC child transport
│   ├── rpc-timeout-finalization.ts # RPC abort-settle-summary recovery
│   ├── rpc-transport-metadata.ts # RPC result policy and bounded metadata helpers
│   ├── rpc-turn-capture.ts       # RPC evidence capture, usage, and budget events
│   ├── auto-transport.ts         # Deterministic preflight transport routing
│   ├── transport-types.ts        # Bounded pi-subagents:v1 progress and telemetry contract
│   ├── usage-recording.ts        # Opt-in content-free event collection and local identities
│   ├── usage-recording-store.ts  # Private per-runtime JSONL writers and retention pruning
│   ├── completion-delivery.ts    # Top-level completion batching and optional idle-root wake
│   ├── session-guidance-contract.ts # Append-only catalog and effective-policy guidance
│   ├── completion-requirement.ts # Exact required-run tracking and fixed-boundary fallback
│   ├── completion-routing.ts     # Direct-parent and live-ancestor recipient selection
│   ├── task-path.ts              # Canonical retained-agent task identity and resolution
│   ├── peer-communication.ts     # Session peer routing and authenticated loopback broker
│   ├── peer-transport.ts         # Child transport bridge wiring and ephemeral credentials
│   ├── child-peer-tools.ts       # Child-only peer tools and context acknowledgements
│   ├── child-peer-bridge.ts      # Explicit process-child extension entrypoint
│   ├── admission-policy.ts       # Audit-only deterministic delegation admission
│   ├── capability-grant.ts       # Generation-bound authority lifetime and revocation
│   ├── execution-plan.ts         # Executor-owned authority and resource resolution
│   ├── work-item-ledger.ts       # Persistent dependency and artifact state machine
│   ├── work-item-persistence.ts  # Atomic redacted workflow state and inspection
│   ├── workflow-verification.ts  # Compatibility independent-verifier receipts
│   ├── verified-execution-contract.ts # Explicit managed-verification request boundary
│   ├── workflow-completion-controller.ts # Sole opted-in terminal acceptance owner
│   ├── verification-harness.ts   # Disposable deterministic check execution
│   ├── verification-receipt.ts   # Strict executor-owned managed receipts
│   ├── verified-execution-benchmark.ts # Matched offline acceptance/cost fixture
│   ├── async-subagent-benchmark.ts # Paired live-quality planning, scoring, and summaries
│   ├── workflow-tree-identity.ts # Bounded exact Git-visible tree identities
│   ├── integration-controller.ts # Fail-closed canonical integration admission
│   ├── adaptive-scheduler.ts     # Dependency, capacity, budget, and conflict scheduling
│   ├── semantic-snapshot.ts      # Privacy-safe continuation compatibility checks
│   ├── supervision.ts            # Bounded idempotent retries and read-only hedging
│   ├── panel-execution.ts        # Blocking review barrier, synthesis, and lifecycle owner
│   ├── panel-contract.ts         # Strict review and synthesis evidence contracts
│   ├── panel-evidence.ts         # Bounded monotonic reviewer evidence ledger
│   ├── panel-planning.ts         # Panel validation, phase budgets, and WorkItems
│   ├── panel-prompts.ts          # Shared-task reviewer and synthesis prompts
│   ├── panel-reconciliation.ts   # Objection-preserving valid-review barrier
│   ├── panel-child-group.ts      # Child signals and disposable-worktree cleanup
│   ├── panel-render.ts           # Compact and expanded sanitized panel rows
│   ├── execution-ui.ts           # Per-agent execution settings screens
│   ├── stateful-guidance.ts      # Detached model-facing workflow guidance
│   ├── stateful-lifecycle.ts     # Runtime disposal and spawn ownership guards
│   ├── timeout-finalization.ts   # Abort-time bounded summary prompts and deadlines
│   ├── timeout-checkpoint.ts     # Redacted deterministic termination evidence
│   ├── turn-budget.ts            # Idle, assistant-turn, and tool-call enforcement
│   ├── runner.ts                 # Blocking subprocess execution and progress capture
│   ├── runner-types.ts           # Shared subprocess result and launch contracts
│   ├── subagent-details.ts       # Composed tool-result and panel detail contracts
│   ├── process-control.ts        # Reusable child-process termination and escalation
│   ├── runner-usage.ts           # Bounded subprocess usage accumulation
│   ├── runner-result.ts          # Shared subprocess result interpretation
│   ├── stateful-limit-ui.ts      # Detached capacity settings and recovery previews
│   ├── stateful-limits.ts        # Shared detached defaults, labels, and validation
│   ├── stateful-safety.ts        # Project-agent and shared-write safety checks
│   ├── stateful-tool-params.ts   # Consolidated action schemas and validation
│   └── *.ts                      # Package-local discovery, execution, rendering, and settings modules
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

`src/index.ts` is the authoritative thin entrypoint and forwards to `subagents-extension.ts`.
The package build bundles that source graph into split `.ts` files under `dist` for Pi's Jiti loader.
`subagents.ts` and `stateful.ts` preserve existing source-level utility imports without making those utility graphs part of Pi startup.
Workflow settings remain backward compatible: older files without `blocking.enabled` receive the eight-tool default, and an absent `blocking.maxParallelTasks` keeps the previous eight-worker limit.
Existing `stateful.enabled: false` files expose deprecated blocking `subagent` plus supported inspection and consultation.
Older package releases ignore and preserve the optional `blocking.maxParallelTasks`, `consult`, `cwdPolicy`, and `usageRecording` fields.
The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./dist/index.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, subagents, agent delegation, parallel agents, review panels, evidence synthesis, fan-in aggregation, chained agents, isolated subprocesses, AI coding workflow, TypeScript Pi package.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
