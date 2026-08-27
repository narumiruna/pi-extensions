---
name: pi-goal-writer
description: Drafts and reviews strong /goal objectives for the pi-goal extension and compatible goal-mode agents. Use when the user asks to write, improve, audit, or meta-prompt a long-running agent goal with clear success criteria, verification, constraints, iteration policy, and blocked stop conditions.
---

# Pi Goal Writer

## Purpose

Write `/goal` prompts that are fit for persistent autonomous work. A goal is not a bigger ordinary prompt; it is a completion contract. The agent will keep using it to decide what to do next and whether it can honestly stop, so the goal must define the desired end state, the evidence that proves it, the constraints that must remain true, and when to stop as blocked instead of drifting.

Use this skill for the `pi-goal` extension first. The same goal-writing principles also apply to Codex Goal mode and compatible `/goal` workflows.

## Runtime contract (pi-goal)

The extension enforces mechanics, so the goal text should define outcomes and evidence, not repeat them:

- Goal text is injected as `<goal_objective>` task data. Rules (audit-before-complete, no narrowed success, inspect current state) are injected automatically.
- The agent ends the goal via the `goal_complete` tool with the exact `goal_id` after every requirement is proven; it cannot stop merely by ending a turn (automatic continuation kicks in).
- `goal_blocked` is only accepted after the same blocker recurs for at least three consecutive goal turns, with evidence. External waits use `goal_wait` (call alone, prefer minutes-long deadlines).
- Objective hard limit is 4000 characters. Longer instructions go in a file referenced from the goal.
- Commands: `/goal <objective>` to start, `/goal pause|resume|clear|status`, `/goal edit [--tokens X] <objective>`.

## Core rule

Never produce a vague goal such as "make this better," "finish the feature," or "improve the codebase." Turn the user's rough intent into a goal with auditable completion criteria.

A strong goal includes six parts:

1. **Outcome** — what must be true when the work is done.
2. **Verification surface** — tests, commands, benchmark output, report, artifact, diff audit, PR state, screenshots, logs, or other concrete evidence.
3. **Constraints** — what must not regress or be changed.
4. **Boundaries** — files, directories, tools, systems, data sources, or permissions the agent may or may not use.
5. **Iteration policy** — how the agent should choose the next action after each attempt.
6. **Blocked stop condition** — what evidence to attach when invoking `goal_blocked` (after the same blocker persists three consecutive turns) instead of drifting.

## Workflow

1. Default to the `pi-goal` extension. Write a `/goal` command unless the user explicitly asks for another harness. Token budgets are opt-in: omit `--tokens` unless the user asks for one. The goal body can usually be reused in Codex Goal mode.
2. Gather context before drafting when the task depends on a repository, issue, test suite, benchmark, PR, design, or external documentation. Read the relevant files or sources instead of inventing the verification surface.
3. Ask at most three clarifying questions only when missing information changes the goal contract. Prefer making safe assumptions explicit when the user is trying to move quickly.
4. Draft the goal as a single pasteable command, then include a short rationale or checklist showing how the six parts are covered.
5. For high-stakes or ambiguous work, provide two options: a narrower goal that is safer to execute and a broader goal that delegates more discovery to the agent. Recommend one.

## Goal template

Use this shape unless the user asks for a different format:

```text
/goal <desired end state>, verified by <specific evidence>, while preserving <constraints>. Use <allowed inputs/tools/scope> and avoid <forbidden scope>. Between iterations, <how to choose the next best action and what to re-check>. If blocked by <blocker>, call goal_blocked with <evidence gathered, attempted paths, exact blocker, next input needed>; if waiting on an external event, arrange a wake message and use goal_wait.
```

Only on explicit user request:

```text
/goal --tokens 100k <same goal contract>
```

## Writing standards

Make the goal self-contained. It should survive context compaction and continuation turns. Keep it under 4000 characters; put longer instructions in a file and reference it from the goal. Include exact command names when known, but do not invent commands. Say "run the relevant project checks identified in AGENTS.md/package scripts" only when exact commands are unknown and the agent can inspect them.

Make completion evidence-based. The goal should require the agent to inspect real artifacts before declaring success: files changed, tests passed, benchmark numbers, rendered screenshots, logs, PR checks, or a written audit. Do not let "tests pass" be the only evidence unless the tests actually cover every requirement.

Bound the scope. Name excluded directories or behaviors when important, such as "do not rewrite CLI user-facing output," "do not change public API behavior," or "do not touch generated files except via the generator."

Preserve honesty under uncertainty. If evidence may be unavailable, require a final report that separates confirmed findings, approximate/proxy evidence, blocked claims, and remaining uncertainty.

Prefer concrete stop language: "If blocked by <X>, call goal_blocked with the exact blocker and what would unlock progress." Avoid weak endings like "do your best."

## Review checklist

Before returning a goal, verify it answers:

- Can the agent tell when it is done?
- Can the user independently audit that completion claim?
- Are regressions and forbidden approaches named?
- Does the goal allow iteration without inviting unlimited drift?
- Does it define what to do when tests, credentials, network, data, or product decisions block progress?
- Is it pasteable as one `/goal` command?

## Examples

Weak:

```text
/goal improve logging
```

Strong:

```text
/goal Implement structured runtime logging, verified by targeted logger tests, the full project check/type/test suite, and final audits showing no production console.* calls outside approved CLI/UI/logger-sink exceptions. Preserve existing operator-visible console behavior, avoid logging secrets or credentials, and keep the logger generic rather than error-only. Between iterations, inspect the diff and audit remaining catch paths before deciding the next change. If blocked, call goal_blocked with the unverified requirement, evidence gathered, and the next input needed.
```

Weak:

```text
/goal fix flaky checkout test
```

Strong:

```text
/goal Diagnose and either fix or conclusively characterize the flaky checkout test, verified by a reliable local reproduction or an evidence-backed failure analysis plus the relevant test command passing when a fix is made. Preserve public checkout behavior and avoid broad timing hacks unless the evidence shows timing is the root cause. Between iterations, record the hypothesis tested, command output, and next most likely cause. If the flake cannot be reproduced or no safe fix remains, call goal_blocked with attempted reproductions, logs, suspected causes, and the missing evidence needed.
```

Weak:

```text
/goal reproduce this paper
```

Strong:

```text
/goal Produce the strongest evidence-backed reproduction of the paper using available local resources, verified by a final claim-by-claim report and any generated artifacts or runnable checks. Attempt the headline results where feasible, label approximate reconstructions separately from exact reproductions, and do not overclaim missing seeds, checkpoints, datasets, or implementation details. Between iterations, map claims to available evidence and prioritize the highest-value verifiable claim. If exact reproduction is blocked, call goal_blocked with confirmed claims, proxy evidence, blocked claims, and the specific missing materials.
```
