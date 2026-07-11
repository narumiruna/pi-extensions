# pi-subagents L1 proactivity evaluation

Original date: 2026-05-17
Updated: 2026-07-11

## Method

The policy remains static tool prompt metadata and documentation, not autonomous runtime orchestration. Tests inspect both blocking `subagent` guidance and default-on background `subagent_spawn` guidance. Live model tool choice is not a deterministic pass/fail oracle.

## Static guidance evidence

- `subagent` says not to delegate critical-path work needed for the main agent's next action.
- A single blocking call is reserved for context/output isolation or independent review that is worth waiting for.
- `subagent_spawn` is reserved for a concrete sidecar task that overlaps meaningful non-overlapping main-agent work.
- Spawn guidance explicitly forbids immediately calling `subagent_wait` unless useful local work is exhausted and progress is genuinely blocked.
- Parallel fan-out remains limited to independent branches; write-heavy shared-file work is serialized.
- Project agents still require explicit scope selection and project trust.

## Decision matrix

| # | Prompt/shape | Expected | Result |
| --- | --- | --- | --- |
| 1 | Audit a completed branch for release blockers. | One blocking independent reviewer can be justified by context isolation. | PASS |
| 2 | Research auth, database, and API modules. | Use 2–4 parallel read-only agents when branches are independent. | PASS |
| 3 | Implement, then independently verify. | Implement locally/serially, then request independent review. | PASS |
| 4 | Explain one README sentence. | No subagent. | PASS |
| 5 | Rename one symbol in one file. | No subagent. | PASS |
| 6 | Use project agents. | Require explicit project scope and trust. | PASS |
| 7 | Spawn one agent for information required before any next step. | Do the critical-path work in the main agent instead of spawning and idling. | PASS |
| 8 | Spawn research while the main agent can implement unrelated scaffolding. | Use background `subagent_spawn`, perform that scaffolding immediately, then inspect/wait only when needed. | PASS |
| 9 | Spawn a background agent, then immediately wait despite known local work. | Explicitly prohibited by `subagent_spawn.promptGuidelines`. | PASS |

Summary: 9 PASS, 0 FAIL.

## Automated evidence

- `extensions/pi-subagents/test/subagents.test.ts` asserts the blocking/critical-path/background guidance.
- `extensions/pi-subagents/test/evolution.test.ts` asserts stateful tools are default-on, can be disabled, and expose the no-immediate-wait guidance.
- `npm run check` is the release gate.

## Runtime boundary

The extension cannot force the model to remain productive after a spawn without adding an autonomous scheduler. Default-on detached lifecycle tools plus explicit prompt rules provide the bounded behavior: spawning does not block, completion remains queryable, and immediate waiting is discouraged. Autonomous continuation remains rejected without explicit opt-in, budgets, stop conditions, and visible controls.
