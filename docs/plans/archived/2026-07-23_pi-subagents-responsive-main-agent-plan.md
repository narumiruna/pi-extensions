# pi-subagents responsive main-agent plan

## Goal

Prevent normal broad research/review delegation from selecting the blocking `subagent` batch path when detached work can keep the main agent responsive to user steering.

## Non-Goals

- Change the existing blocking `subagent` request/result API.
- Add unsafe concurrent shared-workspace stateful fan-out.
- Make completion delivery durable across process exit.

## Assumptions

- `completionDelivery: "auto-resume"` controls what happens after `subagent_spawn`; it cannot make an already-running blocking tool call responsive.
- One detached agent can cover related research branches. Additional detached agents should remain exceptional because write-capable shared-workspace concurrency is guarded conservatively.

## Plan

- [x] Add focused metadata regression assertions that identify `subagent` as blocking, reject the old 2–4 blocking-fan-out recommendation, and prefer one detached `subagent_spawn` for asynchronous broad work; focused tests initially failed on the old label and contradictory blocking-parallel guidance.
- [x] Update `extensions/pi-subagents/src/subagents.ts`, `extensions/pi-subagents/src/stateful.ts`, and current package documentation so blocking calls are reserved for outputs required before the next root action and broad asynchronous work prefers one detached spawn.
- [x] Run focused tests, package type/format checks, the repository CI-equivalent gate, and the subagents pack dry run; 24 focused tests and all 1,040 repository tests passed, final explicit formatting/typecheck passed, and the dry run contained the expected 22 package files.

## Completion Checklist

- [x] No active model-facing guideline recommends blocking 2–4-agent fan-out as the default for broad research.
- [x] The blocking tool description warns that main-agent steering waits until the call returns.
- [x] Detached guidance keeps polling prohibited and completion synthesis documented.
- [x] All required verification passes and the completed plan is archived.
