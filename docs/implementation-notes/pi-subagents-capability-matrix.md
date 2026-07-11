# pi-subagents capability matrix

Date: 2026-07-11

| Capability | Status | Evidence |
| --- | --- | --- |
| One-shot single/parallel/chain/fan-in | Implemented | `extensions/pi-subagents/src/execution.ts`, contract tests in `test/subagents.test.ts` |
| Deterministic timeout and forced kill | Implemented | `runner.ts::terminateProcess`, SIGTERM-resistant fixture in `test/evolution.test.ts` |
| Bounded JSON parsing and output | Implemented | `protocol.ts`, `limits.ts`, parser/truncation tests |
| Abort with partial structured result | Implemented | `runner.ts::runSingleAgent`; abort no longer throws after process settlement |
| Cwd validation and spawn-error normalization | Implemented | `runner.ts::runSingleAgent` |
| Recursion guard | Implemented | `PI_SUBAGENT_DEPTH` / `PI_SUBAGENT_MAX_DEPTH` in `execution.ts` and `runner.ts` |
| Addressable logical agents | Implemented, opt-in | `registry.ts`, `stateful.ts` |
| Follow-up, wait, list, interrupt, close | Implemented, opt-in | six lifecycle tools in `stateful.ts`; registry lifecycle tests |
| Separate active and retained capacity | Implemented | FIFO queue and limits in `registry.ts`; capacity/fairness test |
| Interactive inspection | Implemented | `/subagents:agents list|clear` |
| Native transcript switching | Core-blocked | Extension APIs expose custom entries/UI but no supported child transcript/session switch handle |
| Parent context selection | Implemented, opt-in | `context.ts`: none/all/recent N, text-only sanitation and byte bound |
| Approval/sandbox/header inheritance | Unsupported guarantee | `SingleResult.policy`; only environment and explicit CLI overrides are reported |
| Durable logical history | Implemented, opt-in | versioned mode-0600 state in `persistence.ts` |
| Automatic side-effect resume | Rejected | restored records are always inert `idle` until explicit follow-up |
| Filesystem isolation | Rejected for this phase | children intentionally share cwd/host filesystem; README warns against conflicting writes |
| Autonomous recursive teams | Rejected | bounded recursion defaults to one level; no unbounded scheduler |
