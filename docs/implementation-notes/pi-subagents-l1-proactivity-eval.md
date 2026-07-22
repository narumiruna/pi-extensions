# pi-subagents L1 proactivity evaluation

Original date: 2026-05-17
Updated: 2026-07-23

> Historical evaluation. On 2026-07-23, the detached wait tool was removed and opt-in `stateful.completionDelivery: "auto-resume"` added the bounded autonomous scheduler that this note previously rejected by default.

## Method

The policy remains tool prompt metadata and documentation, not autonomous tool selection. Tests inspect blocking `subagent` guidance and, when stateful tools are enabled, delivery-aware `subagent_spawn` guidance. Changing completion delivery through the settings UI re-registers the spawn tool so its prompt metadata updates immediately. Live model tool choice is not a deterministic pass/fail oracle.

## Prompt guidance evidence

- `subagent` keeps direct critical-path work in the root but permits blocking delegation when an isolated output is required before the next root action.
- The always-registered blocking tool does not advertise optional lifecycle tools; `stateful.enabled: false` therefore leaves no guidance naming unavailable `subagent_spawn`.
- Default `next-turn` guidance prefers one `subagent_spawn` only when the current response does not depend on its result and keeps final-answer-dependent delegation blocking.
- Opt-in `auto-resume` guidance may prefer one `subagent_spawn` for related broad research/review even when the final answer depends on it.
- A blocking call warns that queued steering waits until the call returns.
- One bounded completion message is delivered automatically per settled turn; only auto-resume wakes an idle root turn.
- Spawn guidance explicitly forbids polling; detached lifecycle work exposes no `subagent_wait` tool.
- Parallel fan-out remains limited to independent branches; write-heavy shared-file work is serialized.
- Project agents still require explicit scope selection and project trust.

## Decision matrix

| # | Prompt/shape | Expected | Result |
| --- | --- | --- | --- |
| 1 | Audit a completed branch for release blockers needed in the current response. | Use blocking review under default next-turn delivery; prefer one detached reviewer under auto-resume. | PASS |
| 2 | Research auth, database, and API modules for a later decision. | Prefer one detached scout covering related branches; add concurrency only when work and workspace policy are truly independent. | PASS |
| 3 | Implement, then independently verify. | Implement locally/serially, then request independent review. | PASS |
| 4 | Explain one README sentence. | No subagent. | PASS |
| 5 | Rename one symbol in one file. | No subagent. | PASS |
| 6 | Use project agents. | Require explicit project scope and trust. | PASS |
| 7 | Gather one required fact the root can inspect directly. | Do the critical-path work in the main agent instead of delegating and idling. | PASS |
| 8 | Spawn research while the main agent can implement unrelated scaffolding. | Use one background `subagent_spawn`, perform that scaffolding immediately, and consume automatic completion without polling. | PASS |
| 9 | Spawn a background agent, then poll despite known local work. | Explicitly prohibited by `subagent_spawn.promptGuidelines`. | PASS |
| 10 | Obtain isolated specialist output required before the next root action. | Use blocking `subagent`; direct-work guidance does not prohibit this delegated case. | PASS |

Summary: 10 PASS, 0 FAIL.

## Automated evidence

- `extensions/pi-subagents/test/subagents.test.ts` asserts consistent blocking guidance, disabled-state behavior, and immediate delivery-policy metadata refresh.
- `extensions/pi-subagents/test/orchestration.test.ts` asserts default next-turn and opt-in auto-resume spawn guidance.
- `extensions/pi-subagents/test/evolution.test.ts` asserts stateful tools are default-on, can be disabled, and expose the no-immediate-wait guidance.
- `npm run check` is the release gate.

## Runtime boundary

The extension cannot force the model to remain productive after a spawn without adding an autonomous scheduler. Default-on detached lifecycle tools plus explicit prompt rules provide the bounded behavior: spawning does not block, completion is delivered automatically with `triggerTurn: false`, and polling/immediate waiting is discouraged. Autonomous continuation remains rejected without explicit opt-in, budgets, stop conditions, and visible controls.
