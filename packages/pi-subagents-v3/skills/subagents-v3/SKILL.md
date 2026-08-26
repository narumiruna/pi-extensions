---
name: subagents-v3
description: Operate the minimal pi-subagents-v3 job tools safely, including direct-work decisions, read-only consultations, background delegation, parallel starts, timeout selection, waiting, cancellation, result handling, verification, and writer isolation.
license: MIT
---

# Subagents v3

Use this skill when deciding whether or how to delegate with the `subagent-v3-*` tools.

## Prefer direct work

Keep planning, critical-path work, integration, deterministic checks, and the final answer in the main agent.

Do the work directly when it is simple, latency-sensitive, tightly coupled to the current context, likely to need user clarification, or faster than preparing and verifying a delegation.

Do not delegate merely to avoid work the main agent can complete safely and promptly.

Nested subagents are unsupported.

## Choose consultation or a background job

Use `subagent-v3-consult` for one bounded research, exploration, or review question when the answer is required before the next main-agent action and enforced read-only isolation is useful.

A consultation blocks the caller and cannot edit files, run shell commands, call extension tools, retain a session, or receive follow-up work.

Use `subagent-v3-start` only for a bounded job that can run independently while the main agent performs concrete non-overlapping work.

Do not start a background job when no useful main-agent work can proceed before its result is needed.

Each background job has one task, one turn sequence, an optional execution deadline, and no follow-up conversation.

## Write self-contained tasks

Include the objective, relevant file paths or scope, constraints, allowed mutation, expected output, and evidence requirements in every task.

State explicit ownership for implementation work.

Tell a reviewer or researcher not to edit files.

Do not rely on the child seeing unstated conversation context.

Use a task such as:

```text
Review src/auth.ts for authentication bypass risks.
Do not edit files.
Return findings with severity, exact file and line references, and any unverified assumptions.
```

## Choose timeouts

Set `timeout` in seconds to the shortest realistic execution deadline for the bounded task.

Execution timeouts accept positive finite numbers and have no default.

Omit `timeout` only when the child may run until completion, explicit cancellation, session shutdown, or process exit.

Use short deadlines for extraction and focused review, moderate deadlines for ordinary multi-file work, and longer deadlines only when the scoped work genuinely requires them.

Split an oversized task instead of extending its deadline to compensate for unclear scope.

The execution timeout, when set, belongs to the job and terminates its child when exceeded.

## Start independent jobs in parallel

Start multiple jobs in one Pi parallel tool batch only when they are independent.

Give each parallel writer disjoint file or responsibility ownership.

Use external workspace isolation when writers cannot safely share one working tree.

Never assume concurrent writes serialize or merge automatically.

Keep fan-in synthesis in the main agent because the runtime does not provide aggregators, panels, chains, or workflows.

## Wait intentionally

Use `subagent-v3-wait` only when a specific job result is required for the next action and useful overlapping main-agent work is complete.

Set `subagent-v3-wait.timeout` in seconds only when the caller needs a bounded wait.

Wait timeouts accept positive finite numbers and have no default.

Omitting `timeout` waits until the job becomes terminal or the caller cancels the wait.

A wait timeout stops only the caller's wait.

A wait timeout does not cancel, close, or shorten the job's optional execution deadline.

Do not poll repeatedly because asynchronous completion delivery remains active.

## Inspect and cancel

Use `subagent-v3-inspect` for one bounded snapshot of available agents and retained job metadata.

Inspection omits task text, complete child output, prompts, context, credentials, environment variables, and secrets.

Use `subagent-v3-cancel` when queued or running work is no longer needed, unsafe, stale, or incorrectly scoped.

Cancellation is idempotent, and cancelling a terminal job leaves its state unchanged.

## Handle terminal results

Treat `completed` as a child report that still requires main-agent review and applicable deterministic verification.

Treat `partial` as incomplete evidence, identify what remains unverified, and continue directly or start a newly scoped job only when justified.

Treat `failed` as no reliable completion and inspect the bounded error before choosing a direct fallback.

Treat `timed_out` as terminal for that job, preserve any bounded partial evidence, and do not assume work continued after the deadline.

Treat `cancelled` as terminal and never wait for a later result from that attempt.

Report material limitations instead of presenting partial or failed output as complete.

## Verify worker claims

A worker's statements about edits, tests, checks, or correctness are claims rather than proof.

Inspect the actual shared workspace diff and run the required deterministic checks from the main agent.

Reject unrelated changes and resolve ownership conflicts before integration.

The main agent owns the final conclusion and user-facing handoff.

## Keep orchestration outside the runtime

The runtime does not provide retained conversations, follow-up turns, peer mailboxes, Agent Teams, chains, fan-in aggregators, panels, workflow DAGs, dynamic scheduling, verification orchestration, nested subagents, or extension-owned semantic memory.

Implement any necessary coordination explicitly in the main agent or with separate purpose-built infrastructure.
