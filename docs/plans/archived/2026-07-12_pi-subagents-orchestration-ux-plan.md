## Goal

Improve `pi-subagents` orchestration UX so one-shot parallel requests select the blocking batch API, shared-workspace conflicts produce actionable recovery, and an explicit `subagent_wait` does not also surface a redundant asynchronous completion for the same turn. Success means the observed “spawn three trivial workers” flow completes with one parallel call and one synthesized root response, while detached sidecar workflows retain reliable completion delivery.

## Context

A recent request to run three agents used repeated `subagent_spawn` calls instead of `subagent` parallel mode. The second shared-workspace spawn failed because `scout` is conservatively write-capable through `bash`; two unnecessary worktrees were then created. Although three waits returned the results, the already-scheduled detached completion messages appeared after the root response and caused duplicate follow-up turns.

The current safety guard is correct to treat shell-capable agents as write-capable. This plan improves API selection, diagnostics, and completion consumption rather than weakening that guard or claiming prompt-level read-only intent is a filesystem sandbox.

## Architecture

Keep the existing split between blocking batch jobs and reusable detached agents:

- `subagent` remains the preferred API for independent one-shot single/parallel/chain/fan-in work.
- `subagent_spawn` remains the reusable background API for work that benefits from overlap, retained history, or addressable lifecycle controls.
- Add per-agent-turn completion-consumption bookkeeping at the stateful orchestration boundary. A wait registered before settlement consumes that turn’s completion through the wait result, so the same completion is not also injected asynchronously. Without a registered waiter, detached delivery remains unchanged.
- Keep shared-workspace write detection conservative. Improve the rejection text with safe, context-specific alternatives instead of inferring “read-only” from natural-language task text.

## Non-Goals

- Do not remove or weaken shared-workspace write-conflict protection.
- Do not add an untrusted `readOnly` flag that grants concurrency while shell-capable agents can still write.
- Do not make model-generated numbers cryptographically random; callers needing randomness must request a concrete system randomness source and range.
- Do not replace detached agents with batch workers for reusable, follow-up, mailbox, or background-sidecar workflows.

## Unknowns

- [x] Pi custom messages cannot be retracted safely after settlement, so deduplication is guaranteed only for waits registered while the turn is `starting` or `running`; the README documents late-wait behavior.
- [x] Completion suppression belongs in the transport-neutral extension integration layer: `src/stateful.ts` tracks active waiters while `AgentRegistry` retains its one-completion-per-turn contract.

## Plan

- [x] Add regression tests reproducing the observed API-selection and lifecycle problems in `extensions/pi-subagents/test/subagents.test.ts`, `evolution.test.ts`, and/or `in-process-transport.test.ts`: one-shot parallel guidance must prefer `subagent` parallel mode, a second write-capable shared spawn must return actionable alternatives, and a wait registered before settlement must yield exactly one root-visible result; verify the focused tests fail before implementation with the repository’s compiled Node test command or `npm test`.
- [x] Trace completion ordering across `src/stateful.ts`, `src/registry.ts`, and both transports, recording whether wait registration can be associated with a specific agent turn before `onTurnComplete`; verify with deterministic tests covering completion-before-wait, wait-before-completion, timeout, abort, follow-up turns, and multiple simultaneous waiters.
- [x] Revise the `subagent` and `subagent_spawn` prompt snippets/guidelines in `src/subagents.ts` and `src/stateful.ts` so explicit multi-agent one-shot work selects one blocking parallel call, while detached spawn is reserved for reusable or genuinely overlapping work; verify exact prompt contracts in `extensions/pi-subagents/test/subagents.test.ts`.
- [x] Make shared-workspace conflict errors in `src/stateful.ts` identify the active agent and explain safe next actions: use `subagent` parallel mode for one-shot independent work, wait/close the active detached agent, use `allowConcurrentWrites` only when overlapping writes are knowingly safe, or use `worktree` only when repository isolation is actually needed; verify assertions for spawn and follow-up conflicts without relaxing `isWriteCapable` behavior.
- [x] Implement per-turn completion consumption so a wait registered before settlement receives the terminal result without a duplicate `pi-subagent-completion` injection; preserve asynchronous delivery when no waiter consumes the result and preserve one completion per later follow-up turn. Verify race, timeout, abort, multiple-waiter, subprocess, and in-process cases with deterministic tests.
- [x] Ensure orchestration recovery treats a successfully waited completion as observed and does not schedule an extra synthesis continuation, while unobserved detached completions still recover an idle root exactly once; verify existing orchestration tests plus new wait/delivery interaction tests.
- [x] Update `extensions/pi-subagents/README.md` with a concise decision table for batch parallel versus detached spawn, explain conservative shell/write detection, describe wait-based completion consumption, and show system-randomness wording for tasks where actual randomness matters; verify published package contents with `just pack-subagents`.
- [x] Run a Pi JSON smoke test for the original scenario using three one-shot agents and assert one batch tool call, three ordered results, one root synthesis, no worktrees, and no trailing completion turns; also smoke-test a genuine detached no-wait workflow to confirm asynchronous completion still arrives.
- [x] Run `npm run check` and `just pack-subagents`, inspect the intended diff and tarball; `npm run check` passed all 322 tests and `just pack-subagents` contained all 23 expected package files.

## Risks

- Suppressing completion too broadly could make detached results invisible. Bind consumption to an exact agent turn and retain asynchronous delivery unless a waiter was registered before that turn settled.
- Completion and timeout races could either duplicate or lose output. Define settlement as the single ownership decision point and cover both event orders deterministically.
- Stronger prompt guidance cannot force every model to choose the right API. Actionable runtime errors and duplicate-delivery prevention must remain correct when guidance is ignored.
- More verbose conflict errors could overwhelm tool output. Keep the first sentence diagnostic and the alternatives bounded.

## Completion Checklist

- [x] One-shot multi-agent selection is verified by prompt-contract tests and a Pi smoke trace showing one `subagent` parallel call.
- [x] Shared-workspace safety remains conservative and is verified by existing write-conflict tests plus actionable-error assertions.
- [x] Wait-before-completion produces one root-visible result with no trailing custom completion, verified for subprocess and in-process transports.
- [x] Detached no-wait completion and idle-root recovery still occur exactly once, verified by lifecycle regression tests and a smoke trace.
- [x] Timeout, abort, completion-before-wait, follow-up, and simultaneous-waiter behavior is verified by deterministic tests with no lost terminal output.
- [x] Documentation and publish contents are verified by `just pack-subagents`.
- [x] Repository CI-equivalent validation is verified by a passing `npm run check`.
