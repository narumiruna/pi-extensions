## Goal

Bound `@narumitw/pi-goal` automatic continuation so a model that never calls `goal_complete` cannot create an unbounded, quadratically growing transcript. Count every model response produced by automatically started continuation work—including responses inside tool loops—so the reported exact-reply case stops after a small number of blank/repeated continuations and no automatic run can evade the hard limit by calling tools. Legitimate long-running goals must remain resumable, and retryable provider failures must retain Pi-owned recovery behavior.

## Context

GitHub issue #338 reports 289 assistant calls and about 33 million processed tokens from `pi-goal` 0.24.0. The current source is behaviorally identical to 0.24.0: `agent_end` increments `ActiveGoal.iteration` and requests another continuation after every ordinary unfinished run, but neither `requestContinuation()` nor `dispatchContinuationIfSettled()` enforces a default limit or detects no progress.

Completion cannot safely be inferred from arbitrary assistant text. `goal_complete` must remain authoritative because most objectives require external, file, test, or runtime evidence that the extension cannot verify.

The reported terminal-error suggestion is already partly implemented in 0.24.0: aborts pause, explicit usage exhaustion becomes `usage_limited`, and non-retryable errors become `blocked`. Retryable provider and context-overflow errors intentionally remain active for Pi-owned retry/compaction, so the fix must stop only errors that remain unresolved at `agent_settled`, which Pi documents as the point where no retry, compaction, or follow-up remains.

Pi documents `turn_end` as firing once for each model response plus its tool calls. This is the authoritative boundary for the hard automatic-turn counter: counting only `agent_end` would allow an automatic run to issue unbounded model calls through a tool loop before the counter advances. At the limit, `ctx.abort()` marks the operation aborted before another normal response can complete. Pi may still invoke the provider adapter once with an already-aborted signal and emit a synthetic aborted terminal message; the extension must tolerate that bounded cleanup path rather than promise that no adapter invocation occurs.

Current Codex source at `third_party/codex` (`4462b9deef211723b781b426f5e5d36a5777115f`) does not implement an automatic-turn cap, no-progress detector, or default goal token budget. It instead reduces lifecycle races with a runtime-owned atomic idle gate (`try_start_turn_if_idle`), hidden bounded goal-context fragments, persisted SQLite state, and a goal-state semaphore. Its `on_turn_error` hook runs after a turn is terminal and changes an active goal to `blocked`, or `usage_limited` for usage exhaustion. The Pi fix should copy that terminal-after-retries behavior while adding the two circuit breakers Codex lacks.

## Architecture

Add two default-on settings under a `continuationLimits` object:

```json
{
  "continuationLimits": {
    "automaticTurns": 25,
    "noProgressTurns": 3
  }
}
```

Each value accepts a positive safe integer. Explicit `null` disables that individual guard; removing the authoritative hard bound requires `automaticTurns: null`, while `noProgressTurns` remains independently active unless it is also `null`. Existing settings files inherit both defaults.

Persist per-goal safety state so reload and experimental queue transitions cannot reset a runaway loop:

- `automaticModelTurns`: completed `turn_end` model responses owned by automatically started continuation work in the current safety epoch;
- `toolFreeRepeatCount`: consecutive automatic runs with empty output or the same normalized tool-free output;
- a fixed-size fingerprint of the latest tool-free visible assistant output;
- an optional safety-pause cause (`continuation_limit` or `no_progress`).

Keep lifetime `iteration` unchanged for diagnostics. Define one safety epoch with these transition rules:

- new direct and queued goals start with zeroed safety state;
- successful `/goal resume` and successful active-goal `/goal edit` rotate `goal_id`, reset counters/fingerprint, and clear the safety cause;
- a non-`/goal`, non-extension user/RPC input resets and immediately persists the epoch only while the goal is `active`, and reclassifies any in-flight automatic run as manual from that input boundary;
- manual pause, safety pause, queue shelving/reactivation, automatic queue advance, reload, compaction, and failed prompt delivery preserve the exact epoch and cause;
- stopped goals retain their safety cause until successful reactivation or `/goal clear`;
- queued goals retain independent epochs, including a previously active goal shelved by priority.

Track run ownership separately from `agentRunGoalId`: kickoff, start, resume, edit, and direct user runs are manual; a consumed pi-goal continuation marker makes the run automatic. Pi-owned retry and compaction recovery inherit the originating run's ownership until success, replacement, pause, clear, or `agent_settled`, so retries cannot evade accounting. Clear ephemeral ownership/tool-activity state at every terminal session boundary and guard every update by goal ID.

For every assistant `turn_end` belonging to automatic work, increment and persist `automaticModelTurns` after authoritative usage accounting. Count ordinary, tool-calling, and provider-error responses; ignore only a synthetic `aborted` response caused by this guard itself. When the count reaches `automaticTurns`, atomically pause the matching goal with cause `continuation_limit`, cancel continuation/recovery, block stale goal tool calls, and call `ctx.abort()`. Also enforce the persisted limit before dispatch and restore as a race and migration backstop. The 25th normal response and its already completed tool executions are retained. After that, under Pi's provider abort contract, allow at most the runtime's single provider-adapter invocation with a pre-aborted signal and its synthetic terminal event; it must not produce a 26th normal/billable response or schedule more work.

Evaluate no-progress once at `agent_end` for automatic runs that finish without a terminal error. Normalize visible assistant text only: exclude thinking/tool blocks, strip control characters, apply Unicode normalization and lowercasing, collapse whitespace, and treat punctuation-only output as empty. Persist only a fixed-size hash, never raw assistant text. With no tool call, an empty output continues an empty run and an identical fingerprint continues a repeated-output run; a different non-empty output starts `toolFreeRepeatCount` at one. Any attempted tool call resets the repeat count and fingerprint to zero/null. When the count reaches `noProgressTurns`, pause before requesting another continuation. This avoids arbitrary short-text thresholds and fuzzy semantic similarity; the independent model-turn cap remains authoritative when tools or changing text evade the heuristic.

Use one idempotent safety-pause helper for both guards. It must persist status, usage, epoch, and fixed cause; emit exactly one terminal `pi-goal:state` reason; update `/goal` summary/status; and notify the user with the measured count, cumulative tokens, and `/goal resume` guidance. Later `agent_end`, `agent_settled`, compaction, or stale prompt delivery must not duplicate the stop or notification.

Mirror Codex's terminal-after-retries behavior with explicit `agent_settled` ordering:

1. If goal-scoped recovery still matches the same active goal, finalize that goal as `blocked`; usage exhaustion remains `usage_limited`. Stale recovery for another goal is discarded without mutating the current goal.
2. In the same callback, dispatch any pending queue action against the resulting state so priority/advance cannot become stranded.
3. Only when no queue action remains may ordinary continuation dispatch run.

A started retry, successful turn, Pi-owned compaction retry, replacement, pause, or clear consumes recovery intent before settlement. Safety pause takes precedence over recovery and must not be reclassified as an ordinary abort.

Do not add a default token budget in this change. Token cost and useful goal size vary by provider/model, while the model-turn cap provides a deterministic bound on completed normal responses from automatically initiated work and existing `--tokens` remains available for stricter spend control. Include current cumulative goal tokens in safety notifications, and document that the call-count cap is not a fixed cost ceiling because context size and provider pricing vary.

## Non-Goals

- Automatically marking a goal complete from plain assistant text.
- Treating every provider error as terminal or replacing Pi's retry/compaction policy.
- Fuzzy semantic progress detection, filesystem diff inference, or model-based judging.
- Limiting model turns in the user-triggered kickoff or later manually triggered runs.
- Changing existing user-specified token-budget semantics.

## Risks

- A legitimate tool-heavy automatic run can consume the 25-response allowance before reaching `agent_end`. The pause is recoverable, `/goal resume` creates a fresh explicit epoch, and users can raise or disable the limit deliberately.
- A concise legitimate workflow can trigger the repeat guard. Three distinct short outputs do not trip it; only empty or normalized-identical tool-free runs do.
- Any tool call can evade the repeat guard, including an unproductive one. Counting every automatic `turn_end` keeps the 25-response limit authoritative.
- `ctx.abort()` at `turn_end` can invoke the provider adapter once more with `signal.aborted === true`. Pi providers are expected to honor that signal and produce only a synthetic terminal message; guard-owned abort state must avoid counting or reclassifying it and clear at `agent_settled`. The Pi 0.81.1 runtime smoke must prove this contract for the reported environment; an out-of-contract provider that ignores an already-aborted signal cannot be made a strict cost boundary by an extension hook alone.
- Persisted-state evolution affects experimental queues and reload. New fields must be optional during validation, normalized to safe defaults, and ignored safely by older versions.
- Recovery finalization and pending queue actions share `agent_settled`; goal-ID checks and the specified ordering must prevent stale errors from blocking a replacement goal or stranding priority intent.

## Focused Test Commands

Compile all tests, then run one pi-goal file with:

```bash
./node_modules/.bin/tsc -p tsconfig.test.json
node --test node_modules/.cache/pi-extensions-test/extensions/pi-goal/test/settings.test.js
node --test node_modules/.cache/pi-extensions-test/extensions/pi-goal/test/persistence.test.js
node --test node_modules/.cache/pi-extensions-test/extensions/pi-goal/test/goal.test.js
```

Use the relevant final command after each compile for focused RED/GREEN evidence. Use `npm test` for the complete test suite.

## Plan

- [x] Align the pi-goal runtime-test dependencies in `extensions/pi-goal/package.json` and `package-lock.json` with the reported/current Pi runtime by pinning `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` to `0.81.1`; `npm install` completed and `npm ls @earendil-works/pi-ai @earendil-works/pi-coding-agent --workspace @narumitw/pi-goal` resolved both pi-goal test dependencies to `0.81.1`.
- [x] Add failing settings cases in `extensions/pi-goal/test/settings.test.ts` for defaults, positive overrides, explicit `null`, partial objects, and invalid values; the focused compiled test failed on missing continuation limits before implementation.
- [x] Extend `extensions/pi-goal/src/settings.ts` with normalized `continuationLimits` defaults (`automaticTurns: 25`, `noProgressTurns: 3`) while preserving missing/invalid-file behavior; the focused compiled settings test passes (2/2).
- [x] Add failing cases in `extensions/pi-goal/test/persistence.test.ts` for legacy entries, malformed counters/fingerprints/causes, new queued goals, shelved-goal preservation, and independent queued-goal epochs; the test compile failed on the absent safety fields before implementation.
- [x] Extend `ActiveGoal`, `extensions/pi-goal/src/persistence.ts`, and creation/queue helpers with bounded backward-compatible safety state; the focused persistence test passes (10/10), including legacy normalization and independent queue state.
- [x] Add failing `extensions/pi-goal/test/goal.test.ts` cases proving `turn_end` counts every normal response in automatic tool loops, inherited retry/compaction ownership remains automatic, the limit response pauses and calls `ctx.abort()` once, a guard-owned synthetic abort is ignored, no later continuation is requested, and no later normal response is counted; focused tests failed on the absent hooks before implementation.
- [x] Implement goal-ID-scoped run ownership, tool activity, guard-owned abort state, and automatic `turn_end` accounting in `extensions/pi-goal/src/runtime.ts` and `extensions/pi-goal/src/goal.ts`; focused cap, retry ownership, compaction, and runtime-isolation tests pass.
- [x] Add classifier and lifecycle cases in `extensions/pi-goal/test/goal.test.ts` for blank/punctuation-only output, normalized repeats, distinct short output, text plus a tool call, thinking-only output, malformed content, and issue #338's exact-reply kickoff followed by three blank automatic runs; the lifecycle regression failed before enforcement and passes afterward.
- [x] Implement fixed-size output fingerprinting and `toolFreeRepeatCount` in `extensions/pi-goal/src/safety.ts`, then enforce `no_progress` before continuation request/dispatch/restore; focused tests prove one pause/event/notification and no fourth continuation.
- [x] Add transition cases covering active user/RPC reset plus in-flight run reclassification, stopped-goal input preservation, successful resume/edit reset at owned prompt start, synchronous failed-delivery rollback, extension input, reload, queue shelving/reactivation, automatic advance, and independent queue epochs; focused goal, queue, and persistence tests pass.
- [x] Implement the safety-epoch transition table and idempotent safety-pause helper across `extensions/pi-goal/src/commands.ts`, `extensions/pi-goal/src/goal.ts`, `extensions/pi-goal/src/runtime.ts`, and queue helpers; safety state is preserved until an owned resume/edit prompt actually starts, and exact counters/causes survive rollback and stopped transitions.
- [x] Add error/queue cases in `extensions/pi-goal/test/goal.test.ts` and `goal-queue.test.ts` for retry start, exhausted provider/context errors, pending prioritize plus exhausted recovery, replacement before settlement, compaction consumption, stale goal IDs, usage limitation, hard-cap recovery abort, and safety precedence; focused tests pass.
- [x] Implement matching-goal recovery finalization followed by pending queue dispatch and then continuation dispatch in `agent_settled`; retry/compaction/queue/stale-recovery tests pass, and retry classification now delegates to Pi 0.81.1's public classifier after explicit usage checks.
- [x] Extend `extensions/pi-goal/test/goal-runtime-smoke.mjs` with an Issue #338 scenario: one successful exact-reply kickoff without `goal_complete`, then three blank automatic responses; Pi 0.81.1 runtime smoke proves exactly four non-aborted calls, persisted `paused`/`no_progress`, and no fourth continuation after an idle delay.
- [x] Extend `extensions/pi-goal/test/goal-runtime-smoke.mjs` with an automatic tool-loop scenario using `automaticTurns: 3`; Pi 0.81.1 runtime smoke proves three counted automatic responses, one safety pause/abort, bounded pre-aborted cleanup, and no further call after settlement.
- [x] Add Pi 0.81.1 runtime retry scenarios proving automatic ownership survives a real HTTP 524 retry and a retry that starts after the hard-limit response receives only an already-aborted signal; runtime smoke passes.
- [x] Update `extensions/pi-goal/README.md` with both defaults, normal-response counting and bounded pre-aborted cleanup semantics, `null` opt-in, repeat heuristic, safety-epoch transitions, pause notification/status behavior, the distinction between call count and cost, and `/goal --tokens` guidance; documented fields and transitions match passing tests.
- [ ] Run `npm run check`, `npm run test:runtime --workspace @narumitw/pi-goal`, and `just pack-goal` with pi-goal resolving Pi `0.81.1`; require all commands to pass, inspect the tarball file list against `extensions/pi-goal/package.json`, and record dependency/runtime versions plus passing evidence before marking implementation complete.

## Completion Checklist

- [x] Empty or normalized-identical tool-free automatic runs pause at `noProgressTurns: 3` and cannot enqueue a fourth continuation; three distinct short outputs do not trip the guard.
- [x] Automatic work pauses after the 25th normal `turn_end`, including responses inside tool loops and inherited retry/compaction work; under Pi 0.81.1's provider abort contract, at most one pre-aborted adapter invocation emits only a synthetic terminal event, yields no 26th normal/billable response, and schedules no more work. Only `automaticTurns: null` removes the hard bound.
- [x] Safety epochs reset only on documented successful user-control boundaries and remain exact across stopped states, failed delivery, reload, compaction, shelving, automatic queue activation, and independent queued goals.
- [x] Retryable provider/overflow recovery remains Pi-owned while a retry starts, but matching exhausted recovery stops as `blocked` at `agent_settled`; pending queue actions still dispatch in that callback, stale recovery cannot affect a replacement goal, and usage errors remain distinct.
- [x] Users receive exactly one clear pause reason, measured response/repeat count, cumulative tokens, and resume guidance in notification, summary, and state-event assertions.
- [ ] Existing sessions and queues load with safe defaults without losing state, both real-runtime circuit-breaker scenarios pass on Pi `0.81.1`, and documentation, `npm run check`, runtime smoke, and package dry run all pass.
