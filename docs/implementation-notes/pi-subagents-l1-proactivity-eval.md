# pi-subagents L1 proactivity evaluation

Date: 2026-05-17
Branch: `docs/pi-subagents-proactivity-research-plan`
Base before implementation: `7c7fbd2`

## Method

This MVP changes static tool prompt metadata and docs, not runtime orchestration.
The evaluation therefore checks the current branch's L1 guidance against the six
prompts from `docs/implementation-notes/pi-subagents-proactivity-research.md`.
No live autonomous LLM delegation run was used as the pass/fail oracle because
model tool-choice behavior is nondeterministic and can incur additional nested
subagent calls. The concrete evidence is the implemented `promptSnippet`,
`promptGuidelines`, README rubric, repository checks, package dry run, and an
independent reviewer audit.

## Static guidance evidence

- `extensions/pi-subagents/src/subagents.ts` defines `promptSnippet` and
  `promptGuidelines` on the `subagent` tool.
- The guidelines explicitly say to use `subagent` for independent read-only
  research, high-volume output, multi-domain parallel investigation, and
  independent review after implementation.
- The guidelines explicitly say not to use `subagent` for simple answers, quick
  targeted edits, latency-sensitive one-step work, frequent user back-and-forth,
  same-file write-heavy fan-out, or project-local agents without explicit opt-in.
- `extensions/pi-subagents/README.md` mirrors the rubric in a "Proactive use"
  section and includes good/bad examples.

## Six-prompt matrix

| # | Prompt | Expected | L1 evidence | Result |
| --- | --- | --- | --- | --- |
| 1 | "Audit this branch for release blockers before I merge." | Should use `subagent` `reviewer`/`scout`. | L1 says use `subagent` for independent review and broad read-only reconnaissance. | PASS |
| 2 | "Research auth, database, and API modules in parallel." | Should use parallel `subagent`. | L1 says use `subagent` for multi-domain parallel investigation and parallel mode when tasks are independent. | PASS |
| 3 | "Implement the change, then independently verify it." | Should implement in main/worker, then use `reviewer`. | L1 says use `subagent` for an independent reviewer after implementation and serialize write-heavy work touching the same files. | PASS |
| 4 | "Explain this README sentence in plain language." | Should not use `subagent`. | L1 says do not use `subagent` for simple answers or frequent back-and-forth. | PASS |
| 5 | "Rename `foo` to `bar` in one file." | Should not use `subagent`. | L1 says do not use `subagent` for quick targeted edits or latency-sensitive one-step work. | PASS |
| 6 | "Use project agents to review this repo." | Conditional: require explicit project-agent opt-in and confirmation. | L1 says do not use project-local agents unless the user explicitly wants project agents or sets `agentScope` to `"project"`/`"both"`, and to keep confirmation enabled for untrusted repositories. | PASS |

Summary: 6 PASS, 0 FAIL.

## Verification commands

- `rg -n "promptSnippet|promptGuidelines|Use subagent" extensions/pi-subagents/src/subagents.ts`
- `rg -n "Proactive use|Do not use|project-local" extensions/pi-subagents/README.md`
- `npm run check` — passed.
- `npm run pack:subagents` — passed. Dry-run package contents inspected:
  `LICENSE`, `README.md`, `package.json`, `src/agents.ts`, and
  `src/subagents.ts` only.

## L2 decision

L2 deferred.

The L1 guidance covers all six static expected decisions with explicit positive
and negative rules. Do not add a `before_agent_start` dynamic orchestration hint
until real session evidence shows L1 under-delegates on complex prompts or users
ask for a stronger opt-in coordinator mode. If L2 is revisited, keep it behind a
disabled-by-default feature flag and measure false positives against this same
matrix.
