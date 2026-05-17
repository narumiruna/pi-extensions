# pi-subagents proactivity research

Accessed date for external sources: 2026-05-17.

## Problem

`@narumitw/pi-subagents` already gives the main Pi agent a powerful isolated
`subagent` tool, but the extension mostly waits for the model or user to discover
when to use it. The research question is whether the package should become more
proactive by helping the main agent decompose work into subagents automatically,
without turning every task into expensive, noisy delegation.

## Research scope

Evidence was gathered from:

- Current package code: `extensions/pi-subagents/src/subagents.ts`,
  `extensions/pi-subagents/src/agents.ts`, and `extensions/pi-subagents/README.md`.
- Pi extension API docs:
  `/home/narumi/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`.
- Third-party checked-in code under `third_party/claude-code`.
- External agent orchestration docs, implementations, and research papers.

## Evidence summary

- Current state is **L0 passive delegation**: `subagent` is registered as a custom
tool, but lacks `promptSnippet`, `promptGuidelines`, and any
`before_agent_start` orchestration reminder.
- The lowest-risk improvement is **L1 prompt metadata** on the tool definition.
- A bounded **L2 dynamic orchestration hint** can be tested behind a feature flag
if L1 does not increase correct proactive calls enough.
- L3 coordinator mode and L4 autonomous scheduler are feasible in Pi extension
terms, but should not be the MVP because they add control-flow, loop, trust, and
UX risks.

## Current `pi-subagents` proactivity boundary

| Area | Evidence | Proactivity implication |
| --- | --- | --- |
| Tool registration | `extensions/pi-subagents/src/subagents.ts:590-600` registers `name: "subagent"`, label, description, and schema. The definition does **not** define `promptSnippet` or `promptGuidelines`. | The model can call the tool, but Pi's default prompt lacks a compact always-visible usage hint for when to decompose work. |
| Execution modes | `extensions/pi-subagents/src/subagents.ts:609-612` enforces exactly one mode; `:667-722` handles chain mode; `:728-856` handles parallel mode and optional `aggregator`; `:866-894` handles single mode. | The runtime already supports the workflows that proactive prompting would recommend: single, parallel, chain, and fan-in. |
| Parallel limits | `extensions/pi-subagents/src/subagents.ts:31-32` sets `MAX_PARALLEL_TASKS = 8` and `MAX_CONCURRENCY = 4`; `:729-735` rejects over-large parallel batches; `:778` uses `mapWithConcurrencyLimit`. | There is already a guardrail for over-delegation; prompt guidance can safely mention parallel fan-out within these limits. |
| Status UI | `extensions/pi-subagents/src/subagents.ts:49-79` publishes status through `ctx.ui.setStatus`; chain/parallel/single calls update it at `:670`, `:740`, and `:866`. | Users can see active subagent work, but status is reactive, not a trigger for delegation. |
| Agent scope and trust | `extensions/pi-subagents/src/subagents.ts:603-606` defaults to `agentScope: "user"`; `:641-663` asks before using project-local agents when UI is available. | Proactive guidance must not suggest project-local agents unless `agentScope` is explicitly enabled and confirmation is respected. |
| Built-in agents | `extensions/pi-subagents/src/agents.ts:23-69` defines `scout`, `planner`, `reviewer`, `worker`, `general`, and `general-purpose`. | There are enough built-ins for a decomposition rubric: read-only research, planning, independent review, and implementation. |
| Agent discovery | `extensions/pi-subagents/src/agents.ts:155-189` discovers nearest `.pi/agents`, merges built-ins, user agents, and project agents by requested scope. | A dynamic roster is possible, but injecting it every turn risks prompt growth/cache churn. |
| Documentation | `extensions/pi-subagents/README.md` documents delegation modes, built-ins, project-agent confirmation, runtime limits, and status. | User docs cover explicit usage, but not a proactive rubric for the main agent. |

Verification grep target: `registerTool`, `promptSnippet`, `promptGuidelines`, and
`before_agent_start` are intentionally named here because the current package has
`registerTool` but no `promptSnippet` / `promptGuidelines` / `before_agent_start`
usage in `extensions/pi-subagents/src`.

## Pi extension intervention points

All `docs/extensions.md` line references in this table refer to
`/home/narumi/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`.

| Pi extension mechanism | Source reference | Possible proactivity mechanism | Fit |
| --- | --- | --- | --- |
| `promptSnippet` | `docs/extensions.md:1217-1240`, `:1664-1668` says custom tools can add a one-line `Available tools` entry. | Add a short `subagent` summary such as: "Delegate independent research, review, or multi-step work to isolated workers." | Best L1 default. Low risk, static, low token cost. |
| `promptGuidelines` | `docs/extensions.md:1225-1227`, `:1666-1668` says guideline bullets are appended flat and must name the tool. | Add explicit rules: when to use `subagent`, when not to use it, prefer read-only parallel scouts, use `reviewer` after implementation. | Best L1 default. Must keep bullets concise and tool-named. |
| `before_agent_start` | `docs/extensions.md:466-501` can inject a message or modify the system prompt and exposes `systemPromptOptions`. | L2 feature flag can add a dynamic roster and a per-turn decomposition reminder only for complex prompts. | Useful spike. Risk: prompt churn and false positives. |
| `input` event | `docs/extensions.md:806-850` can inspect raw input before skill/template expansion. | Detect explicit phrases like "parallel agents" or "subagents" and add/transform hints. | Limited. Raw input pre-expansion makes it brittle. Avoid for MVP. |
| `sendMessage` | `docs/extensions.md:1268-1289` injects custom messages and can trigger turns. | Could implement background scheduler/status nudges. | L4 only. High loop/UX risk. |
| `sendUserMessage` | `docs/extensions.md:1291-1307` injects user-role follow-ups and always triggers a turn. | Could automatically ask the agent to continue with verification after subagents finish. | L4 only. Must be explicit opt-in. |
| `agent_end` | `docs/extensions.md:503-510` fires after a prompt completes. | Record eval telemetry or decide whether to queue follow-up. | Good for metrics; dangerous for autonomous scheduling without hard stop rules. |
| `status UI` | `docs/extensions.md:2184-2189` provides `ctx.ui.setStatus`. | Display proactive mode or active subagent work. | Already used for runtime status; useful for L2 visibility. |
| `context` | `docs/extensions.md:282-289`, `:589-594` can modify messages during turns. | Could inject adaptive reminders later. | More invasive than L1/L2; not needed for MVP. |

## Third-party implementation references

| Path | Pattern observed | Pi applicability |
| --- | --- | --- |
| `third_party/claude-code/tools/AgentTool/prompt.ts` | Lines `:59-64` describe moving dynamic agent lists into messages to avoid tool-schema cache bust; `:83-112` explains fork vs fresh agent prompting; `:235-241` lists when **not** to use agents; `:270-271` says descriptions with "use proactively" should be honored and parallel requests should launch multiple agents in one message. | Highly applicable to L1/L2 prompt design. Use concise static guidelines first; if adding roster, prefer dynamic message injection over changing tool schema. |
| `third_party/claude-code/coordinator/coordinatorMode.ts` | Lines `:185-218` define coordinator phases and concurrency rules; `:213-218` says parallel read-only research is safe but write-heavy work should serialize; `:220-227` defines real verification; `:280-293` decides continue vs spawn by context overlap. | Applicable as a future L3 coordinator mode/command, but too large for MVP. Its rules should inform the L1 rubric. |
| `third_party/claude-code/tools/TeamCreateTool/prompt.ts` | Lines `:7-12` proactively create a team for complex multi-agent work; `:37-48` define a team workflow; `:51-63` explains automatic message delivery and idle teammate semantics. | Useful future inspiration for persistent teams. Not directly portable because Pi `subagent` currently has no shared task list, teammate identities, or continuation channel. |
| `third_party/claude-code/tools/AgentTool/runAgent.ts` | Lines `:368-383` handle context forking; `:391-406` omit irrelevant context for read-only agents; `:414-452` handles permission prompt behavior; `:500-516` resolves per-agent tools; `:530-554` runs SubagentStart hooks and injects additional context. | Useful later for context slimming, lifecycle hooks, and permission isolation. Current Pi subprocess isolation is simpler; MVP should not add fork semantics. |

## External sources

| Source | accessed | Key points | Pi applicability |
| --- | --- | --- | --- |
| Claude Code subagents docs, https://code.claude.com/docs/en/sub-agents | accessed 2026-05-17 | Claude delegates based on task descriptions and subagent descriptions; recommends phrases like "use proactively"; subagents preserve context, enforce tool constraints, and support parallel research, chaining, foreground/background, and forked context. It also lists when to use the main conversation instead: frequent back-and-forth, shared context, quick targeted changes, and latency-sensitive work. | Strong evidence for L1 descriptions/guidelines and for an explicit "when not to delegate" rubric. |
| Anthropic, "Building effective agents", https://www.anthropic.com/engineering/building-effective-agents | accessed 2026-05-17 | Recommends the simplest solution that works; distinguishes workflows from autonomous agents; identifies prompt chaining, routing, parallelization, orchestrator-workers, and evaluator-optimizer patterns; warns that agents trade latency/cost for task performance and need guardrails. | Supports incremental L1/L2 before L3/L4. Confirms parallelization and orchestrator-worker patterns, but also validates not using agents for simple tasks. |
| LangChain multi-agent docs, https://docs.langchain.com/oss/python/langchain/multi-agent | accessed 2026-05-17 | Multi-agent value comes from context management, distributed development, and parallelization. Subagents are a pattern where the main agent coordinates subagents as tools; routers and skills are alternatives. Performance tables show subagents are efficient for large-context multi-domain tasks but add calls for one-shot/repeat tasks. | Reinforces that `subagent` as a tool is a valid architecture and that prompt guidance should reserve it for multi-domain/large-context tasks. |
| LangGraph Supervisor repo, https://github.com/langchain-ai/langgraph-supervisor-py | accessed 2026-05-17 | Implements a central supervisor coordinating specialized agents through tool-based handoffs; README now recommends manual supervisor patterns for more control over context engineering. | Useful L3 reference. Pi can emulate supervisor guidance via prompts/tool calls, but a dedicated coordinator mode should be a later opt-in feature. |
| AutoGen group chat docs, https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/design-patterns/group-chat.html | accessed 2026-05-17 | Group chat uses specialized agents sharing a message thread; a manager selects next speaker, can dynamically decompose complex tasks, and stops on termination conditions. Docs warn the Core API example is complex and not production-ready as-is. | Shows a richer multi-agent UX but also warns against unnecessary complexity. Pi MVP should not introduce group chat/state machines. |
| CrewAI processes docs, https://docs.crewai.com/en/concepts/processes | accessed 2026-05-17 | Supports sequential and hierarchical processes; hierarchical mode uses a manager LLM/agent for planning, delegation, validation, and task allocation by capability. | Confirms coordinator/manager pattern, but importing that abstraction would be beyond a small Pi extension MVP. |
| Plan-and-Solve Prompting, https://arxiv.org/abs/2305.04091 | accessed 2026-05-17 | Plan-and-Solve prompting first devises a plan to divide a task into smaller subtasks, then executes subtasks; it targets missing-step errors in multi-step reasoning. | Supports a main-agent instruction to plan decomposition before spawning subagents, rather than spawning reflexively. |

## Proactivity levels

| Level | Name | Trigger | Mechanism | Cost | Complexity | Safety risk | Recommendation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| L0 | Passive tool | User/model explicitly calls `subagent`. | Current `registerTool` only. | Low unless used. | Existing. | Low. | Baseline only; insufficient for proactive decomposition. |
| L1 | Tool prompt hints | Model sees static tool guidance every turn. | Add `promptSnippet` and `promptGuidelines` to `subagent`. | Very low token cost. | Low. | Low; still model-decided. | **MVP default.** |
| L2 | Dynamic orchestration prompt | User prompt appears complex, multi-domain, review-heavy, or explicitly asks for parallelism. | `before_agent_start` injects a concise decomposition rubric and optional built-in/user agent roster, behind feature flag. | Moderate; roster may add tokens/cache churn. | Medium. | Medium; false positives and project-agent trust boundaries. | Spike after or with L1, disabled by default. |
| L3 | Coordinator mode/command | User opts into `/subagents:coordinate` or similar for complex work. | Dedicated coordinator prompt/mode with phases: research, synthesis, implementation, verification. | Higher latency/cost. | High. | Medium-high; more control flow and UX surface. | Future implementation plan only after L1/L2 eval. |
| L4 | Autonomous scheduler | Extension self-queues follow-ups after agent end or subagent completion. | `agent_end`, `sendMessage`, `sendUserMessage`, persistent state, stop rules. | Potentially unbounded without limits. | Very high. | High; loops, surprise actions, user trust. | Do not implement without explicit opt-in, hard budgets, and visible controls. |

## Task decomposition rubric

### Use `subagent` when

- The task has independent read-only research branches that can be summarized.
- The task asks for multiple perspectives, an audit, or adversarial verification.
- A long command, log, web search, or repository search would flood the main context.
- Implementation is followed by independent review or verification.
- The work can be described with self-contained context, expected output, and done criteria.
- Parallel tasks touch different modules or are read-only.
- A built-in read-only agent (`scout`, `planner`, `reviewer`) is enough, or custom user agents are explicitly available.

### Do **not** use `subagent` when

- The answer is simple, conversational, or already in the main context.
- The task needs rapid user back-and-forth or clarification.
- Multiple workers would edit the same files or shared state concurrently.
- The prompt involves sensitive/high-risk actions and extra delegation would reduce oversight.
- The task is latency-sensitive and the subagent start-up cost is not justified.
- Project-local agents are needed but `agentScope`/confirmation has not been requested.
- The main agent has not synthesized research into exact file paths, line numbers, and changes.

### Classified example prompts

| Prompt | Classification | Suggested action | Rationale |
| --- | --- | --- | --- |
| "Audit this branch for release blockers before I merge." | Use subagent | Parallel `scout`/`reviewer`, optional fan-in `reviewer`. | Independent read-only checks and adversarial review are useful. |
| "Research auth, database, and API modules in parallel and summarize risks." | Use subagent | Parallel `scout` tasks with an aggregator. | Distinct domains and parallelizable research. |
| "After you finish the implementation, get a second opinion." | Use subagent | Run `reviewer` after edits/tests. | Fresh verification avoids implementation bias. |
| "Find all files related to statusline rendering." | Use subagent if broad | `scout` when search space is large; main agent if known path. | Verbose search can be isolated, but small targeted lookups should stay main. |
| "Rename this variable in `src/foo.ts`." | Do not use | Main agent edits directly. | Simple, targeted, shared context; subagent adds overhead. |
| "Explain what this README paragraph means." | Do not use | Answer directly. | Conversational explanation, no tool-heavy work. |
| "Use project agents to review the security model." | Conditional | Use `agentScope: "both"` only after confirmation. | Project agents are repo-controlled and require trust boundary handling. |
| "Run the full test suite and summarize only failures." | Use subagent | `reviewer` or `worker` with no edits. | High-volume output is isolated from main context. |
| "Implement frontend and backend changes that touch the same schema file." | Split carefully | Research can fan out; implementation serialized in main or one worker. | Write conflicts make parallel implementation unsafe. |
| "Keep working automatically until everything is perfect." | Do not use L4 | Ask for bounded objective or use explicit plan. | Open-ended auto-scheduling risks loops and uncontrolled cost. |

## MVP design options

| Option | Correctness | UX | Latency | Cost | Safety | Implementation effort | Assessment |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A. Add only `promptSnippet` / `promptGuidelines` (L1) | Medium: improves model selection but no classifier. | Good: invisible unless model chooses tool. | Best. | Best. | Best: no new control flow. | Low. | **Recommended MVP default.** |
| B. Add `before_agent_start` dynamic hint and agent roster (L2) | Medium-high if prompts match rubric. | Mixed: more visible guidance, but potential false positives. | Slightly worse. | Moderate prompt tokens/cache churn. | Medium: must respect project-agent confirmation. | Medium. | Recommended as feature-flag spike after L1. |
| C. Add coordinator mode/command (L3) | High for complex work when opted in. | Good for explicit complex tasks; too heavy for normal turns. | Higher. | Higher. | Medium-high due worker orchestration. | High. | Future plan only. |
| D. Add autonomous scheduler (L4) | Unknown; can recover/verify but may loop. | Risky: surprising follow-ups. | Worst/unbounded. | Worst/unbounded. | Highest. | Very high. | Reject for now; only explicit opt-in with budgets later. |

## Bounded L1/L2 spike design

No production code was touched in this research pass, so a live LLM baseline/candidate
measurement was not executed. A deterministic result would require a local-only
candidate branch, configured model, and repeated prompts. The spike should be run
as part of the follow-up MVP implementation plan. If code is touched during that
spike, run `npm run check`.

Feature flag proposal:

- L1 is always on after merge: static `promptSnippet` and `promptGuidelines`.
- L2 is off by default behind `PI_SUBAGENTS_PROACTIVE_HINTS=1` or a package-local
  equivalent while measuring false positives.

Eval matrix:

| # | Prompt | Expected | Baseline L0 record | Candidate L1 record | Candidate L2 record | Pass criterion |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | "Audit this branch for release blockers before I merge." | Should use `subagent` `reviewer`/`scout`. | Record whether current main agent delegates. | Record delegation, summary quality. | Record delegation, false-positive notes. | Uses subagent and returns grounded blocker list. |
| 2 | "Research auth, database, and API modules in parallel." | Should use parallel `subagent`. | Record number of agents. | Record if parallel mode chosen. | Record if parallel mode chosen. | Uses one parallel call, not serial calls. |
| 3 | "Implement the change, then independently verify it." | Should use main/worker for implementation and `reviewer` after. | Record whether review is skipped. | Record reviewer use. | Record reviewer use. | Independent verification occurs after edits. |
| 4 | "Explain this README sentence in plain language." | Should **not** use `subagent`. | Record direct response. | Record direct response. | Record direct response. | No subagent call. |
| 5 | "Rename `foo` to `bar` in one file." | Should **not** use `subagent`. | Record direct edit. | Record direct edit. | Record direct edit. | No subagent call. |
| 6 | "Use project agents to review this repo." | Conditional: ask/confirm or use only when `agentScope` requested. | Record behavior. | Record behavior. | Record behavior. | Does not bypass project-agent confirmation. |

## Recommendation

Yes, it is worth making `pi-subagents` more proactive, but only at L1 by
default. The current tool already supports the right execution primitives; the
missing piece is clear model-facing guidance on when to decompose, when to
parallelize, and when not to delegate.

Recommended route:

1. Implement L1 in the next PR: add `promptSnippet` and concise
   `promptGuidelines` to `extensions/pi-subagents/src/subagents.ts`.
2. Document the rubric in `extensions/pi-subagents/README.md` so users can tune
   their prompts and custom agents.
3. Run the six-prompt spike above before and after L1.
4. Only if L1 under-delegates, test L2 `before_agent_start` dynamic hints behind
   a disabled-by-default feature flag.
5. Defer L3 coordinator mode and reject L4 autonomous scheduling until there is
   explicit user opt-in, budgets, stop conditions, and UI visibility.

A follow-up implementation plan was created at
`docs/plans/2026-05-17_pi-subagents-l1-proactivity-mvp-plan.md`.

## Risks moved to implementation planning

- **Over-delegation:** mitigate with explicit "do not use subagent" bullets and
eval prompts that must remain no-delegation.
- **Write conflicts:** recommend read-only fan-out and serialized implementation.
- **Project-agent trust boundary:** keep `agentScope` defaulting to `user` and do
not suggest project agents unless the user opts in.
- **Prompt cache churn:** keep L1 static; if L2 adds roster, make it feature-flagged
and concise.
- **Autonomous loops:** do not implement L4 in the MVP.

## Completion evidence

- Current code boundary: exact source references above for tool registration,
execution modes, status, agent scope, and built-ins.
- Pi API intervention points: exact docs references above for `promptSnippet`,
`promptGuidelines`, `before_agent_start`, `sendMessage`, `sendUserMessage`, and
status UI.
- Third-party references: table above covers four checked-in Claude Code files.
- External references: table above covers seven URLs with `accessed` dates and
`Pi applicability` notes.
- Proactivity levels, rubric, MVP matrix, and bounded spike matrix are included
in this document.
