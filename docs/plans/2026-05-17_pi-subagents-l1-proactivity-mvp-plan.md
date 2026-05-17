## Goal

Implement the recommended L1 proactivity MVP for `@narumitw/pi-subagents`: make
the existing `subagent` tool more discoverable to the main Pi agent with concise
static prompt metadata and user-facing docs, then verify that the added guidance
encourages appropriate delegation without encouraging trivial over-delegation.

## Context

Research conclusion lives in
`docs/implementation-notes/pi-subagents-proactivity-research.md`. The selected MVP
is L1: add `promptSnippet` and `promptGuidelines` to the existing tool definition.
L2 `before_agent_start` dynamic hints remain a feature-flagged future spike unless
L1 evaluation shows under-delegation.

## Non-Goals

- Do not add coordinator mode, teams, continuation channels, or autonomous
  scheduler behavior in this MVP.
- Do not change subagent execution semantics, project-agent confirmation, or
  concurrency limits unless the L1 implementation requires it.
- Do not enable project-local agents proactively by default.

## Plan

- [ ] Add L1 prompt metadata to `extensions/pi-subagents/src/subagents.ts` by
  defining `promptSnippet` and concise `promptGuidelines` on the `subagent`
  `registerTool` call; verify with
  `rg -n "promptSnippet|promptGuidelines|Use subagent" extensions/pi-subagents/src/subagents.ts`.
- [ ] Keep the guidance bounded by encoding both use and non-use criteria: use
  `subagent` for independent read-only research, parallel multi-domain work, and
  independent review; avoid it for simple answers, same-file write conflicts,
  untrusted project agents, or latency-sensitive one-step work; verify by reading
  the final `promptGuidelines` bullets.
- [ ] Update `extensions/pi-subagents/README.md` with a short "Proactive use"
  section that mirrors the rubric and includes at least one good and one bad
  delegation example; verify with
  `rg -n "Proactive use|Do not use|project-local" extensions/pi-subagents/README.md`.
- [ ] Run the six-prompt L1 evaluation matrix from
  `docs/implementation-notes/pi-subagents-proactivity-research.md` against the
  current branch and record results in
  `docs/implementation-notes/pi-subagents-l1-proactivity-eval.md`; verify with
  `rg -n 'Audit this branch|Rename.*foo|PASS|FAIL' docs/implementation-notes/pi-subagents-l1-proactivity-eval.md`.
- [ ] Run repository verification after code/docs changes; verify with
  `npm run check` from the repository root.
- [ ] Preview the package contents after metadata/docs changes; verify with
  `npm run pack:subagents` and confirm the tarball includes the intended source
  and README files only.
- [ ] Decide whether L2 is still needed based on the eval results; verify by
  recording either "L2 deferred" or a new L2 plan path in
  `docs/implementation-notes/pi-subagents-l1-proactivity-eval.md`.

## Risks

- Prompt metadata may over-delegate if guidelines are too eager; keep explicit
  negative cases in the bullets and eval matrix.
- Long guidelines can bloat the default system prompt; keep L1 static and short.
- Project-local agents remain repo-controlled; do not imply they are safe without
  explicit `agentScope` and confirmation.

## Completion Checklist

- [ ] `subagent` has static L1 prompt metadata, verified by source grep for
  `promptSnippet` and `promptGuidelines`.
- [ ] User docs explain proactive and non-proactive use cases, verified by README
  grep evidence.
- [ ] The six-prompt eval is recorded with pass/fail outcomes and an L2 decision,
  verified by the eval note path.
- [ ] `npm run check` passes after the implementation.
- [ ] `npm run pack:subagents` passes and the dry-run package contents are
  inspected for intended files.
