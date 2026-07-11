## Goal

Prevent `pi-subagents` from leaving the root session permanently idle after detached delegation, while preserving its stricter rule that simple or critical-path work should stay with the main agent. Success means detached agents are coordinated through completion or explicit cancellation, their results are synthesized by the root agent, and unnecessary single-agent delegation remains discouraged.

## Context

The current `subagent_spawn` contract asks the main agent to continue meaningful non-overlapping work and discourages an immediate `subagent_wait`, but completion is injected with `triggerTurn: false`. If the model yields immediately after spawning, an idle root session is not resumed.

Codex uses a different orchestration invariant: while delegated agents are live, the root must wait before yielding. This plan adopts that lifecycle guarantee without adopting Codex's broader preference for delegation. A single subagent remains appropriate only for concrete isolation or specialization benefits such as independent review, bounded context/output, a different model/tool profile, or workspace/permission isolation.

## Architecture

Track ephemeral delegation state per root turn inside the stateful subagent extension. A spawn marks the current turn as requiring coordination. Completion, interruption, close, session replacement, and shutdown update or clear that state. If the root settles while delegated work is still live or completed output has not received a synthesis turn, schedule one bounded orchestration continuation through Pi's settled lifecycle rather than relying on an idle completion message.

The normal path remains one active root turn: the model may perform local work, call `subagent_wait`, consume completion, and synthesize. Automatic continuation is a recovery path only when the model incorrectly yields.

## Non-Goals

- Do not require a `mainTask` parameter on `subagent_spawn`.
- Do not prohibit a single subagent when isolation or specialization provides concrete value.
- Do not make every detached completion autonomously wake an unrelated idle session.
- Do not persist root-turn orchestration markers across reloads or session replacement.
- Do not copy Codex's instruction that the root should avoid doing useful local work while agents run.

## Assumptions

- `agent_end` can record continuation intent and `agent_settled` can safely dispatch it, following the repository's established late-turn pattern.
- Completion messages delivered during an active turn remain the preferred path; recovery should not duplicate already-consumed output.
- One recovery continuation per delegation-state revision is sufficient to prevent silent idle without creating an unbounded autonomous loop.

## Plan

- [x] Added focused lifecycle tests in `extensions/pi-subagents/test/evolution.test.ts` and `in-process-transport.test.ts` for immediate settlement, root work, completion ordering, unsynthesized output, interruption/close, newer root work, session reset, pending-message gates, and failed delivery; narrow and full suites pass.
- [x] Added `src/orchestration.ts` with ephemeral generation, nonce, revision, agent, observation, pending-ticket, and bounded-delivery state; deterministic state-transition tests pass.
- [x] Wired spawn/follow-up, terminal completion, wait observation, interruption completion, close/subtree close, clear, replacement, and shutdown into ephemeral orchestration state; registry and integration lifecycle tests pass.
- [x] Added nonce/revision-guarded `agent_end` follow-up queuing with pending-message-gated `agent_settled` fallback; newer root work, revision changes, reset/shutdown, failed delivery, and exactly-once recovery are covered by tests and the JSON smoke trace.
- [x] Defined bounded recovery text in `src/orchestration.ts` covering local work, wait, synthesis, interrupt/close, no unnecessary spawning, and no endless waiting; prompt assertions and smoke behavior pass.
- [x] Updated batch/stateful prompt guidelines and spawn result text with the hybrid policy; prompt-contract tests in `subagents.test.ts` and `evolution.test.ts` pass.
- [x] Made waits abortable without terminating agents while preserving immediate terminal return and timeout semantics; registry abort/timeout tests and bounded continuation tests pass.
- [x] Updated `extensions/pi-subagents/README.md` with blocking/detached distinctions, justified single-agent use, coordination recovery, and cancellation/timeout behavior; package review confirms the README and source are published.
- [x] Completed the sibling edge-case scan; fixed completion-before-spawn tracking, completion-versus-settlement revision races, follow-up tracking, wait cancellation, and accepted-continuation start races, with regression coverage.
- [x] Ran `npm run check` (322 tests), `just pack-subagents` (23 files including `src/orchestration.ts`), and a Pi 0.80.6 JSON smoke; evidence showed one recovery user message, one completion, `subagent_wait`, `subagent_close`, and final `ROOT_SYNTHESIZED_DELAYED_OK`.

## Risks

- Automatic continuation can create unwanted model turns. Mitigate with idle/pending-message gates, generation and revision guards, and at most one accepted recovery per unchanged orchestration revision.
- A completion can race root settlement or user steering. Mitigate by snapshotting state before dispatch and cancelling stale intent whenever the revision or session generation changes.
- Treating every completion as unsynthesized can cause duplicate synthesis. Track whether a later root turn was started with that completion available, and test completion-before/after-settlement ordering.
- Waiting indefinitely would reproduce Codex's coordination cost without its native mailbox runtime. Preserve bounded waits and require explicit additional waits rather than an internal endless loop.

## Completion Checklist

- [x] Immediate yield recovery verified by deterministic lifecycle tests and the Pi JSON smoke (`recoveryUserMessages: 1`).
- [x] Main-agent work and explicit result observation verified by `root orchestration accepts completion synthesized during useful root work`.
- [x] Single-agent isolation policy and unchanged blocking batch behavior verified by prompt-contract and full tests.
- [x] Completion/failure terminal handling, interruption, close, timeout, newer root work, reset, and shutdown semantics verified by unit and integration lifecycle tests.
- [x] One recovery per unchanged revision verified by repeated lifecycle events, state tests, and the one-message JSON smoke trace.
- [x] Common stateful registration covers both transports; in-process integration tests and subprocess-backed Pi smoke both pass.
- [x] README and package contents verified by `just pack-subagents`; `src/orchestration.ts` is included.
- [x] Repository CI-equivalent verification passed with `npm run check` (322/322 tests).
