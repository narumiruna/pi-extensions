# pi-subagents spawn thinking-level plan

## Goal

Let the root agent choose the lowest sufficient Pi thinking level for each `subagent_spawn` task, while preserving all existing defaults when the optional override is omitted.

## Plan

- [x] Add red tests under `extensions/pi-subagents/test/` for the spawn schema/rubric, lifecycle propagation and observability, transport precedence, persistence compatibility, and omission fallback; `npm test` failed on the missing `ManagedAgent.thinkingLevel` contract and subprocess resolver as intended.
- [x] Add optional `thinkingLevel` to the stateful spawn contract and `ManagedAgent`; tests prove registry copies, follow-ups, persistence/restore, and list/result summaries retain it.
- [x] Apply spawn override precedence in `SubprocessTransport` and `InProcessTransport`; tests cover explicit override, agent default, model suffix, parent snapshot, and omission.
- [x] Add model-facing `subagent_spawn` guidance that selects the lowest sufficient level from `off|minimal|low|medium|high|xhigh|max` without a heuristic or extra classifier call; schema/guidance tests pass.
- [x] Document selection ownership, rubric, precedence, lifecycle retention, Pi capability clamping, and omission compatibility in `extensions/pi-subagents/README.md`.
- [x] Run `npm run check` (1,054 tests plus Biome, boundaries, and workspace typechecks) and `pi -ne -e ./extensions/pi-subagents --help`; both passed.

## Assumptions

- The root agent selects `thinkingLevel` from the delegated task; the extension does not infer difficulty.
- An explicit spawn level applies to the entire retained agent lifecycle. `subagent_send` does not gain a per-turn override.
- The requested level may be clamped by Pi for the selected model and is not claimed as the provider's effective level.
- The persisted state version and existing blocking `subagent` API remain unchanged.

## Completion Checklist

- [x] `subagent_spawn` accepts exactly the seven Pi levels and advertises the difficulty rubric.
- [x] Explicit levels reach both transports, survive follow-up/restore, and are observable in stateful tool details.
- [x] Omitted levels preserve existing transport fallbacks and legacy persisted records.
- [x] Illegal persisted levels are rejected by the existing quarantine path.
- [x] README, tests, full repository check, and headless extension smoke are complete.
