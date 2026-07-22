# pi-subagents capability matrix

Date: 2026-07-11
Updated: 2026-07-23

| Capability | Status | Evidence |
| --- | --- | --- |
| One-shot single/parallel/chain/fan-in | Implemented | `extensions/pi-subagents/src/execution.ts`, contract tests in `test/subagents.test.ts` |
| Deterministic timeout and forced kill | Implemented | `runner.ts::terminateProcess`, SIGTERM-resistant fixture in `test/evolution.test.ts` |
| Bounded JSON parsing and output | Implemented | `protocol.ts`, `limits.ts`, parser/truncation tests |
| Abort with partial structured result | Implemented | `runner.ts::runSingleAgent`; abort no longer throws after process settlement |
| Cwd validation and spawn-error normalization | Implemented | `runner.ts::runSingleAgent` |
| Recursion guard | Implemented | `PI_SUBAGENT_DEPTH` / `PI_SUBAGENT_MAX_DEPTH` in `execution.ts` and `runner.ts` |
| Detached addressable agents | Implemented, default-on | `subagent_spawn` returns immediately; bounded completions use default non-triggering delivery or opt-in batched `auto-resume`; disable with `stateful.enabled: false` |
| Transport abstraction and fallback | Implemented | `transport.ts`, default `subprocess-transport.ts`, opt-in public-SDK `in-process-transport.ts` |
| Hierarchical ownership and subtree lifecycle | Implemented | parent/root/depth/children metadata and child-first interrupt/close in `registry.ts` |
| Bounded asynchronous mailbox | Implemented | message/read/ack tools, deduplication, completion delivery, and persistence tests |
| Shared-write guard and disposable worktrees | Implemented, opt-in | `stateful.ts`, `workspace.ts`; clean-repository and cleanup tests |
| Follow-up, mailbox, list, interrupt, close | Implemented, default-on | seven non-waiting lifecycle tools in `stateful.ts`; registry and completion-delivery tests |
| Separate active and retained capacity | Implemented | FIFO queue and limits in `registry.ts`; capacity/fairness test |
| Interactive settings and inspection | Implemented | `/subagents settings|status|help`, compatibility `/subagents:config`, and `/subagents:agents list|clear` |
| Native transcript switching | Core-blocked | Extension APIs expose custom entries/UI but no supported child transcript/session switch handle |
| Parent context selection | Implemented | `context.ts`: none/all/summary/recent N/entry IDs, text-only sanitation and byte bound |
| Approval/sandbox/header inheritance | Unsupported guarantee | `SingleResult.policy`; only environment and explicit CLI overrides are reported |
| Durable logical history | Implemented | versioned mode-0600 state in `persistence.ts`; restored in-process sessions seed bounded prior turn boundaries once |
| Automatic side-effect resume | Rejected | restored records are always inert `idle` until explicit follow-up |
| Filesystem isolation | Optional | shared cwd is default; disposable clean-Git worktrees are available through `workspaceMode: "worktree"` |
| Autonomous recursive teams | Rejected | bounded recursion defaults to one level; no unbounded scheduler |
