## Goal

Merge `extensions/experimental/pi-goals` into `@narumitw/pi-goal` as an opt-in ordered-goal queue while preserving default single-goal behavior. Only `/goal`, `goal_complete`, `goal_blocked`, the `goal` status key, and canonical `goal-state` persistence remain.

## Architecture

- `~/.pi/agent/pi-goal.json` enables queue mode with `experimental.goals: true`; the default is `false`, and settings reload only at session startup/replacement or `/reload`.
- Existing `/goal` commands remain unchanged. Queue mode adds canonical `add`, `prioritize`, `drop-last`, and `skip` subcommands; hidden compatibility aliases are `push`, `unshift`, `pop`, and `shift`.
- `goal.ts` remains the per-factory lifecycle coordinator. Pure queue transformations live in `queue.ts`; command parsing, persistence, prompts, and accounting remain focused modules.
- Canonical persistence keeps the legacy `{ goal }` shape when no queue metadata is needed and optionally stores queued goals and pending queue actions. Legacy `goals-state` is imported only when the branch has no canonical `goal-state` entry.
- Disabling queue mode with retained queue state freezes the queue without prompts, continuation, mutation, or data loss. `/goal` shows the frozen queue and `/goal clear` removes it; re-enabling restores it.

## Plan

- [x] Add failing settings/command/runtime tests for the default-off flag, queue commands, hidden aliases, and unchanged default parsing; verified by initial compile/assertion failures followed by the passing real Pi runtime ordered-queue scenario.
- [x] Implement `experimental.goals` settings normalization and runtime-aware command parsing/completion; verified by 513 passing root tests, including default parser regressions, canonical queue names, hidden aliases, and settings shape validation.
- [x] Add failing persistence/queue tests for canonical queue state, legacy migration, pending prioritize, malformed input, and queue-state detection; verified by the initial missing-export/module TypeScript failures.
- [x] Implement canonical queue persistence plus pure queue transitions in `src/queue.ts`; verified by 523 passing root tests covering canonical shape preservation, precedence, legacy conversion, malformed fail-closed behavior, ordering, accounting rebasing, and stopped heads.
- [x] Add failing lifecycle tests for add/prioritize/drop-last/skip, settled advancement, per-goal accounting, stopped states, reload, stale runs, delivery failures, tool policy, frozen queues, and per-factory isolation; verified by red tests for missing queue behavior plus 541 passing tests after implementation.
- [x] Integrate queue state into the singular per-factory `GoalRuntime` while preserving existing goal safety behavior; verified by the full existing pi-goal suite plus queue regressions for concurrent completion/prioritize, shutdown/reload, pending skip suppression, budget, retry/compaction, stale ids, and restrictive tools.
- [x] Update the runtime smoke test to prove default and opt-in queue behavior register only singular identifiers; verified by `npm run test:runtime --workspace @narumitw/pi-goal`.
- [x] Remove `extensions/experimental/pi-goals`, its dedicated recipe/reference, and lockfile workspace entry while retaining generic experimental infrastructure; verified by path/reference checks, pinned npm 11.16.0 lock regeneration, a clean workspace graph, and `just --list` without `try-goals`.
- [x] Update package/root documentation and active MEMORY notes for the merged interface; verified by active-reference audits and README review.
- [x] Run formatting, full checks, pi-goal runtime smoke, package dry run, recipe inspection, reference audits, and `git diff --check`; final verification passed with 476 tests, 16 workspace typechecks, real runtime queue advancement, and a 10-file pi-goal tarball.
- [x] Archive this plan after every completion check passes; archived at `docs/plans/archived/2026-07-15_pi-goal-experimental-queue-merge-plan.md`.

## Risks

- Queue activation can race old `agent_end`, continuation delivery, compaction, or pending messages. Every head replacement must be owned by the originating goal and activated only from a persisted settled-boundary intent.
- Default mode must not reserve queue words as subcommands or change the persisted single-goal shape.
- Legacy plural state must not override a canonical clear, and malformed state must never start autonomous work.
- Disabling the feature must preserve queued data while preventing hidden automatic work.

## Completion Checklist

- [x] Default single-goal behavior is unchanged, proven by the complete pre-existing pi-goal suite plus default parser/settings regressions.
- [x] Opt-in canonical commands and aliases preserve the complete ordered-goal behavior, proven by unit/integration tests and the real Pi ordered-queue smoke scenario.
- [x] Queue lifecycle, accounting, stale guards, tool visibility, retry/compaction, delivery rollback, and frozen-state safety are covered by regressions for settled completion/skip/priority, abrupt reload, shutdown, stale ids, restrictive tools, budget, and child runtimes.
- [x] Legacy `goals-state` migration and canonical-clear precedence are proven by persistence tests.
- [x] Only `@narumitw/pi-goal` remains for this feature; standalone paths, plural runtime identifiers, and `try-goals` are absent from active runtime/docs and the workspace graph.
- [x] `npm run check`, pi-goal runtime smoke, `just pack-goal`, `just --list`, active-reference audits, and `git diff --check` pass; final verification emitted `FINAL_VERIFICATION_PASSED`.
- [x] Documentation describes the opt-in queue, commands, aliases, freeze behavior, and migration.
