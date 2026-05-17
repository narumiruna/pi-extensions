## Goal

Make `/goal <your_goal>` replace an existing unfinished goal directly, so users can update the active objective without first running `/goal clear`, `/goal stop`, or `/goal edit`.

## Context

`extensions/pi-goal/src/goal.ts` previously rejected `/goal <objective>` when a non-complete goal existed and told users to run `/goal edit <objective>` or `/goal clear` first. The README documented the same behavior.

## Non-Goals

- Remove `/goal edit`; it remains as a compatibility/explicit-edit command.
- Change `/goal pause`, `/goal resume`, `/goal clear`, `/goal status`, `/goal-stop`, or `goal_complete` semantics.

## Plan

- [x] Update `startGoal` in `extensions/pi-goal/src/goal.ts` so a valid `/goal <objective>` always creates and persists a new active goal, replacing any unfinished goal; verified with `npm run check`.
- [x] Adjust the user notification for replaced goals to distinguish first start from replacement; verified by diff review of `extensions/pi-goal/src/goal.ts` showing `Goal replaced (...)` versus `Goal started`.
- [x] Update `extensions/pi-goal/README.md` command docs so `/goal <goal_to_complete>` is documented as start-or-replace while `/goal edit` remains an alias/explicit replacement path; verified with `rg -n "starts goal mode when no other|edit <goal|replace|replaces" extensions/pi-goal/README.md`.
- [x] Run formatting and repository checks for the touched TypeScript/docs; verified with `npm run check`.

## Risks

- A user might accidentally overwrite an active goal by typing a new `/goal`; this is intentional for this change and mitigated by keeping `/goal` bare as status-only and notifying that the previous goal was replaced.

## Completion Checklist

- [x] `/goal <your_goal>` replacement behavior is implemented in `extensions/pi-goal/src/goal.ts` and verified by successful `npm run check` output.
- [x] README usage and command reference match the new replacement behavior, verified by repository diff review and `rg -n "starts goal mode when no other|edit <goal|replace|replaces" extensions/pi-goal/README.md`.
- [x] All relevant validation commands completed successfully, verified by successful `npm run check` output.
