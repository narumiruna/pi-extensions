---
name: writing-plans
description: Draft, execute, or track lean, verifiable implementation plans for non-trivial migrations, refactors, PR splits, task checklists, and other work with sequencing, tradeoffs, unknowns, or risks; use writing-roadmap for strategic direction and skip small obvious tasks.
---

# Writing Plans

A plan request authorizes creating or revising the plan artifact, not implementation.
Execute the plan only when the user requests it or an active workflow already authorizes the work.

## Ground the Plan

Inspect relevant repository evidence before asking questions.
Ask at most one question when proceeding would require a risky guess; otherwise state only assumptions and unknowns that affect execution or validation.

Save a drafted plan to the repository unless the user requests chat-only output.
Default to `docs/plans/YYYY-MM-DD_<topic>-plan.md` with a concise lowercase kebab-case topic, and update an existing plan in place during execution.

## Structure the Plan

Always include `Goal`, `Plan`, and `Completion Checklist`.
Add only useful optional sections from this list:

```markdown
## Context
## Architecture
## Tech Stack
## Non-Goals
## Assumptions
## Unknowns
## Risks
## Rollback / Recovery
```

Use `Architecture` for system boundaries, ownership, data flow, APIs, state, permissions, storage, or deployment.
Use `Tech Stack` for tool, runtime, and package choices.
Include `Rollback / Recovery` for production data, migrations, infrastructure, releases, or public APIs.

## Write Executable Tasks

Use Markdown checkboxes that each name one action, its object, the expected result, and acceptance evidence.

```markdown
- [ ] Update `src/auth.ts` to reject expired tokens; verify with `npm test -- auth`.
```

Order tasks by dependency, and turn material unknowns into early discovery tasks.
Avoid vague, combined, or open-ended tasks such as “improve quality,” “handle edge cases,” or “monitor forever.”
End with finite completion checks tied to files, commands, tests, review or deployment state, or explicit user acceptance.

## Execute and Track

- Check a task only after its acceptance method passes.
- Add concise evidence when completion is not obvious from repository state.
- Leave failed or unavailable checks open, and mark an inapplicable task as `- [x] Not applicable: <reason>`.
- Reopen a task when later work invalidates its evidence.
- Track only the current saved plan, and do not inspect or alter unrelated plans.
- Show updated checkboxes and evidence in chat when the plan is chat-only.

Declare completion only when every task and completion check is checked, material unknowns are resolved or accepted, risks have a clear disposition, and required handoff or release work is done.
Do not infer completion from implementation alone.

## Archive Completed Plans

Move a fully executed saved plan to `docs/plans/archived/`, then report its path.
Do not archive a chat-only plan, a plan with missing evidence, or a plan whose archived filename already exists.
