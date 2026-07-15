## Goal

Add configurable pi-goal tool visibility with `"always"` as the backward-compatible default and `"after-first-goal"` as an opt-in lazy mode, while fixing the availability, extension-ordering, restore, and formatting problems found during review. Success means an active goal never continues autonomously without `goal_complete` and `goal_blocked`, and pi-goal does not fight another extension's restrictive tool policy on every turn.

## Context

The current branch introduces a runtime-sticky unlock: both goal tools are hidden before the first activation, then re-added and reasserted from `before_agent_start`. Review found that a later `setActiveTools()` caller can still overwrite that reassertion, while the reverse handler order can bypass the other extension's policy. A restored active goal can also remain active when its terminal tools are unavailable.

## Architecture

Add user settings at `~/.pi/agent/pi-goal.json` with this shape:

```json
{
  "toolVisibility": "always"
}
```

Supported values are `"always"` and `"after-first-goal"`. Missing settings or an omitted property resolve to `"always"`; malformed settings warn and safely fall back to `"always"`. Do not create the file automatically.

`"always"` means pi-goal never proactively hides its registered tools. `"after-first-goal"` hides them at fresh session startup, reveals them for the first successfully accepted goal activation, and keeps them desired for the remainder of that extension runtime; restoring an unfinished goal also marks them unlocked without widening an active set already restricted by an earlier lifecycle handler. Other extensions may temporarily apply a stricter tool set in either mode. pi-goal must not repeatedly overwrite that policy: if an active goal cannot access both terminal tools, it pauses safely and suppresses automatic continuation.

## Non-Goals

- Do not build a generic active-tool policy merger for Pi extensions.
- Do not redesign Plan mode or support simultaneous autonomous Goal mode and restrictive Plan mode in this change; Plan mode's restrictive tool set wins, and the goal pauses rather than fighting it.
- Do not persist the optional unlock across a new extension runtime when no unfinished goal is restored.
- Do not add environment-variable configuration or create a settings editor command.

## Plan

- [x] Added `extensions/pi-goal/src/settings.ts` with typed synchronous loading for `pi-goal.json`, `"always"` defaults, and bounded invalid-file reporting; isolated temporary-path tests cover missing, omitted, valid, malformed, invalid-value, and unreadable inputs.
- [x] Added lifecycle tests for both visibility modes: missing/invalid/explicit `"always"` settings keep both tools active, while `"after-first-goal"` hides them until an accepted activation or unfinished-goal restore; the tests failed before runtime integration and pass in the 435-test repository suite.
- [x] Refactored `extensions/pi-goal/src/goal.ts` to load settings at `session_start`, scope sticky visibility to `"after-first-goal"`, restore the locked set after failed first delivery, and keep successful unlocks through completion/clear for the current runtime; lifecycle and parent/child isolation tests pass.
- [x] Removed per-turn `setActiveTools()` reassertion and added availability guards at restore, start/resume/reactivating edit, prompt injection, `agent_end`, and continuation dispatch; allowlist, partial-reveal cleanup, busy-turn widening, exact settings-mode restoration, exact failed-kickoff rollback, asynchronous replacement ownership, stale queued-prompt rejection, replacement rollback, restrictive restore ordering, startup follow-up preservation, Goal-owned prompt aborts, unrelated-turn tool preservation, stop-precedence, budget-precedence, paused-state, and no-continuation assertions pass.
- [x] Added both restrictive-policy ordering scenarios, including Plan-mode-shaped whole-set replacement; tests prove the earlier removal pauses before Goal prompt injection, while later removal pauses at `agent_end` without re-adding tools or dispatching continuation.
- [x] Documented the cross-extension ownership rule and failure-safe connection behavior in `docs/implementation-notes/pi-goal-plan-mode-tool-policy.md`; source behavior and ordering tests match the documented restrictive-policy precedence.
- [x] Updated `extensions/pi-goal/README.md` with the `pi-goal.json` path, both values, the `"always"` default, runtime-scoped lazy semantics, malformed-config fallback, failed-kickoff rollback, and restrictive-policy pause behavior.
- [x] Formatted and verified the completed change: targeted Biome check, package typecheck, isolated-agent-dir runtime smoke, canonical-`TMPDIR` `npm run check` with 435 passing tests, and `just pack-goal` all pass; the dry run contains nine expected files including `src/settings.ts`.

## Risks

- `setActiveTools()` replaces the whole active set, so any attempt to force visibility from multiple extensions remains order-dependent; mitigate by treating a later restrictive policy as authoritative and pausing the goal.
- Loading settings at `session_start` must finish before the first model request; synchronous one-file loading and post-start active-set tests keep that boundary deterministic.
- Runtime-scoped `"after-first-goal"` may surprise users after reload when no unfinished goal exists; document this exact scope rather than implying permanent unlock.
- Pausing after a later handler removes tools may allow the current model call to run once without terminal tools; the `agent_end`/continuation guard must prevent an autonomous loop.

## Rollback / Recovery

Keep `"always"` behavior independent of lazy state so the optional mode can be removed without changing the default contract. If lazy visibility proves unreliable, retain settings parsing temporarily, treat both values as `"always"` with a warning, and remove the deprecated value in a later release.

## Completion Checklist

- [x] Missing, valid, and invalid `pi-goal.json` behavior is verified by isolated settings tests; `"always"` is the default and source contains no config-file write path.
- [x] Both visibility modes and runtime reset/restore semantics are verified by lifecycle tests that assert exact active-tool sets.
- [x] Active goals cannot start, restore, or auto-continue without both terminal tools, verified by allowlist, partial activation, exact settings-mode restoration, busy-turn, replacement, clobber-order, unrelated-turn tool preservation, status-precedence, paused-state, and no-continuation assertions.
- [x] pi-goal no longer reasserts `setActiveTools()` from `before_agent_start`, verified by source review and both restrictive-policy ordering tests.
- [x] User and implementation documentation matches the configuration and policy-precedence behavior, verified in `extensions/pi-goal/README.md` and `docs/implementation-notes/pi-goal-plan-mode-tool-policy.md`.
- [x] Repository and package gates pass, verified by the isolated-agent-dir runtime smoke, canonical-`TMPDIR` `npm run check` with 435 tests, and inspected nine-file `just pack-goal` output.
