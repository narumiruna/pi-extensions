## Goal

Research whether `@narumitw/pi-subagents` should become more proactive, and how: let the
main agent decide when a task is suitable for multiple subagents, when to parallelize, and
when to keep the work on the main path. The final output should be an evidence-backed
research conclusion and MVP recommendation. Success criteria: the research document clearly
lists viable options, risks, third-party implementation references, external research or
implementation sources, and a recommendation on whether to proceed to implementation.

## Context

- `extensions/pi-subagents/src/subagents.ts` currently mainly registers a passive
  `subagent` tool. It supports single, parallel, chain, and fan-in aggregator modes, but it
  has no `promptSnippet` / `promptGuidelines` and does not dynamically remind the main agent
  to split work through `before_agent_start`.
- `extensions/pi-subagents/src/agents.ts` already has built-in `scout`, `planner`,
  `reviewer`, and `worker` agents, but the main agent may not see strong enough "when to
  use this" rules before deciding whether to call `subagent`.
- `third_party/claude-code` already contains useful multi-agent / coordinator
  implementation traces, including `tools/AgentTool/prompt.ts`,
  `coordinator/coordinatorMode.ts`, `tools/TeamCreateTool/prompt.ts`, and
  `tools/AgentTool/runAgent.ts`.
- Pi extension docs already provide possible intervention points: tool metadata
  (`promptSnippet` / `promptGuidelines`), `before_agent_start` system prompt injection,
  `sendMessage` / `sendUserMessage`, and status UI.

## Non-Goals

- This plan does not directly require completing a production implementation; decide
  whether to open an implementation plan after the research is complete.
- Do not aim to "automatically assign subagents for every task"; the research must clearly
  distinguish proactive use from over-delegation.
- Do not assume the Claude Code coordinator/team architecture should be copied; extract only
  designs that fit Pi extension boundaries.

## Assumptions

- First evaluate low-risk prompt / tool metadata approaches, then evaluate coordinator or
  autonomous scheduler approaches.
- Proactivity must preserve cost, latency, safety confirmation, and write-conflict control;
  "more parallel agents" cannot be the only success metric.

## Unknowns

- Whether `promptSnippet` / `promptGuidelines` are sufficient for making the main agent
  proactively call `subagent` more often, or whether stronger orchestration rules must be
  dynamically injected through `before_agent_start`.
- Whether a Pi extension is a good place to implement a true autonomous scheduler, such as
  automatically asking follow-up questions or continuing after `agent_end`, without causing
  a feedback loop or violating user expectations.
- Whether adding a dynamic agent roster would cause prompt cache busting, higher token cost,
  or conflicts with the project-local agent confirmation safety model.

## Plan

- [x] Create the research output file
  `docs/implementation-notes/pi-subagents-proactivity-research.md` with research scope,
  problem definition, evidence tables, and conclusion sections; verify with
  `test -f docs/implementation-notes/pi-subagents-proactivity-research.md` and
  `rg -n "Problem|Evidence|Recommendation" docs/implementation-notes/pi-subagents-proactivity-research.md`.
- [x] Inventory the current `pi-subagents` proactivity boundary, recording
  `registerTool` metadata, execution modes, status updates in
  `extensions/pi-subagents/src/subagents.ts`, and built-in agents in
  `extensions/pi-subagents/src/agents.ts`; verify with exact path references in the
  research note and
  `rg -n "registerTool|promptSnippet|promptGuidelines|before_agent_start" extensions/pi-subagents/src docs/implementation-notes/pi-subagents-proactivity-research.md`.
- [x] Inventory available Pi extension intervention points and map `promptSnippet`,
  `promptGuidelines`, `before_agent_start`, `sendMessage`, `sendUserMessage`, and status UI
  to viable proactivity mechanisms; verify with cited references to
  `/home/narumi/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
  in the research note.
- [x] Research the `third_party/claude-code` multi-agent implementation and summarize at
  least the useful and non-portable patterns from `tools/AgentTool/prompt.ts`,
  `coordinator/coordinatorMode.ts`, `tools/TeamCreateTool/prompt.ts`, and
  `tools/AgentTool/runAgent.ts`; verify with a table in the research note listing each
  path, pattern, and Pi applicability.
- [x] Search for related external research and implementations, collecting at least five
  sources such as multi-agent orchestration, task decomposition, tool-use prompting, agent
  swarm/coordinator UX, and Claude Code/Codex-like features. Each source needs a URL,
  access date, key summary, and Pi applicability; verify with
  `rg -n "https?://|accessed|Pi applicability" docs/implementation-notes/pi-subagents-proactivity-research.md`.
- [x] Define proactivity levels from L0 passive tool, L1 tool prompt hints, L2 dynamic
  orchestration prompt, L3 coordinator-style mode, to L4 autonomous scheduler, listing
  triggers, cost, implementation complexity, and safety risks; verify with a level
  comparison table in the research note.
- [x] Design a task decomposition rubric that clearly lists suitable cases, such as
  independent read-only research, multi-angle review, and independent verification after
  implementation, plus unsuitable cases, such as simple answers, strongly shared context,
  same-file write conflicts, sensitive/high-cost tasks, and unauthorized project agents;
  verify with at least 8 example prompts classified by the rubric in the research note.
- [x] Evaluate MVP design options, comparing at least "only add `promptSnippet` /
  `promptGuidelines`", "add `before_agent_start` dynamic hints and agent roster", "add
  coordinator mode/command", and "add autonomous scheduler"; verify with a decision matrix
  covering correctness, UX, latency, cost, safety, and implementation effort.
- [x] Plan a bounded spike using a feature flag or local-only branch to test whether L1/L2
  increases proactive call rate, with 6 test prompts, including 3 that should use subagents
  and 3 that should not, plus baseline/candidate result records; verify with an eval matrix
  saved in the research note and successful `npm run check` if code is touched.
- [x] Not applicable: explicit user review cannot be completed autonomously in goal mode; the `Recommendation` section clearly answers whether proactivity is worthwhile, which MVP level is recommended, and which risks move to the implementation plan, with follow-up review/implementation captured in `docs/plans/2026-05-17_pi-subagents-l1-proactivity-mvp-plan.md`.
- [x] If the user accepts the research conclusion, open a separate implementation plan for
  the selected MVP; verify with a new `docs/plans/YYYY-MM-DD_<topic>-plan.md` path or
  explicit user acceptance that no implementation plan is needed.

## Completion Evidence

- Research output created: `docs/implementation-notes/pi-subagents-proactivity-research.md`.
- Current `pi-subagents` passive/proactive boundary is documented with exact references to `extensions/pi-subagents/src/subagents.ts` and `extensions/pi-subagents/src/agents.ts`.
- Pi extension intervention points are documented with references to `/home/narumi/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`.
- `third_party/claude-code` patterns are documented for `tools/AgentTool/prompt.ts`, `coordinator/coordinatorMode.ts`, `tools/TeamCreateTool/prompt.ts`, and `tools/AgentTool/runAgent.ts`.
- External sources table includes seven URLs, `accessed 2026-05-17`, summaries, and Pi applicability notes.
- Proactivity levels, decomposition rubric, MVP decision matrix, and bounded L1/L2 spike matrix are included in the research note.
- Follow-up implementation plan created: `docs/plans/2026-05-17_pi-subagents-l1-proactivity-mvp-plan.md`.
- Verification commands run successfully: research-note `rg` checks and `npm run check`.
- Independent `reviewer` subagent returned PASS for the research note, archived plan, follow-up plan, and `npm run check` evidence.

## Risks

- Over-delegation increases token cost, wait time, and UI noise; the research must offset
  this with clear "when not to use subagents" guidance.
- Automatic decomposition with writable agents may cause same-file contention or
  overwrites; the research should prioritize read-only fan-out and implementation
  serialization.
- Project-local agents are controlled by the repo; more proactive use must not bypass the
  existing confirmation and trust boundary.
- A dynamic agent roster or long orchestration prompt may cause prompt cache busting or
  context growth; the research must evaluate tradeoffs between static tool metadata and
  dynamic message injection.
- A true autonomous scheduler may create an automatic follow-up loop; the research must
  define stop conditions, user visibility, and opt-in design.

## Completion Checklist

- [x] The current passive/proactive boundary of `pi-subagents` has been verified by exact
  code references, with evidence in
  `docs/implementation-notes/pi-subagents-proactivity-research.md`.
- [x] The relevant `third_party/claude-code` implementation has been summarized into
  portable/non-portable pattern tables, verified by path references to at least four
  third-party files in the research note.
- [x] External research and implementation search is complete, verified by at least five
  sourced URLs with access dates and Pi applicability notes in the research note.
- [x] Proactivity levels, decomposition rubric, and MVP decision matrix are complete,
  verified by corresponding tables and at least eight classified example prompts in the
  research note.
- [x] The L1/L2 bounded spike or an explicit reason not to run the spike is recorded,
  verified by an eval matrix plus `npm run check` if code was touched, or by a documented
  not-applicable rationale.
- [x] The final recommendation has either been accepted by the user or converted into the
  next implementation plan, verified by explicit user acceptance or a new plan path.
