# Progress and recovery

[Back to README](../README.md)

## Recovery review

`/goal status` and the manager's **View full status** show the saved stop reason, cumulative usage, automatic-work count, recorded requirements and evidence, and a state-specific next action.
Stopped and waiting goals use a read-only recovery review; return to the manager to resume, review the automatic-work limit, or increase the budget.
Reading or cancelling the review does not resume paid work.
Older session records without a stop reason say so instead of guessing.

The last recorded evidence is the most recently updated requirement with non-empty evidence, not a claim that the tool result was useful or independently validated.
All checklist statuses are agent reports.
External changes can invalidate evidence after it was recorded; the agent must recheck it after resuming and before completion.

## Requirement/evidence tool

Use `goal_progress` only for the currently owned active Goal, with its exact `goal_id`:

```json
{
  "goal_id": "<current-goal-id>",
  "requirements": [
    {
      "id": "regression",
      "text": "The regression test passes",
      "status": "verified",
      "evidence": "npm test: regression test passed; packages/example/test/regression.test.ts"
    }
  ]
}
```

Omit `requirements` or pass an empty array to read without changing the checklist.
Updates merge by id, preserve omitted requirements, and apply atomically after validation.
An existing id's text cannot change, and there is no removal action.
Use `unverified`, `verified`, or `blocked`; a verified item requires non-empty concrete evidence.
Ids contain 1–64 ASCII letters, digits, dots, underscores, or hyphens, starting with a letter or digit.
Each goal supports 32 requirements, with at most 500 characters of text and 1,000 characters of evidence per item.
Tool text is bounded to 50 KB/2,000 lines; full structured state remains in tool-result details if display is truncated.

Once requirements are recorded, `goal_complete` rejects completion while any item is unverified, blocked, or missing evidence.
There is no independent command execution or evidence verifier: this barrier enforces recorded coverage, not truth or completeness of the checklist itself.
Goals without a checklist retain the existing completion contract for compatibility.
When available, the active Goal instructions ask the agent to record the full checklist early and read it again after resume or compaction.
A restrictive tool allowlist must include `goal_progress` to permit checklist reads and updates; Goal does not widen it.

Checklist state is stored in the current branch's `goal-state` entries, including across reload, compatible forks, and compaction.
New goals and objective edits start fresh checklists; budget-only edits and resumes preserve them.
A failed edit delivery restores the previous checklist with the previous goal.
Malformed persisted checklists become an explicit unverified reconstruction requirement rather than silently removing the completion barrier.
No global file or project settings are created for checklist state.

## Tool-loop diagnostics

At each owned active Goal turn, diagnostics compare finalized top-level tool calls using the tool name, arguments, error flag, and returned content.
They retain only SHA-256 fingerprints, not extra copies of commands, results, or image data.
Object key order and parallel result arrival order do not matter; argument strings and result content otherwise match exactly.
Tool ids, timestamps, usage, and result details are excluded.
Nested calls are not separately observed because they do not have matching top-level transcript calls.
Goal's four bookkeeping tools are excluded.

A call/result fingerprint appearing in at least three of the last six turns raises a warning when it appears again.
Duplicate identical calls in one parallel batch count once for that turn.
At most 32 distinct fingerprints are sampled per turn; calls after that bound are not considered.
Missing results and tool-free turns age the six-turn window.
The warning clears when the current turn has no matching repeated sample and can appear again in a later episode.

Warnings appear in the UI and full status, and in the next automatic-continuation prompt.
They never pause, abort, change counters, or create a model turn themselves.
The bounded diagnostic history survives reload and compaction; safety-epoch resets and goal edits clear it.
This heuristic can flag intentional repeated reads, failures, or external polling and can miss loops whose output changes.
It does not replace the automatic-response cap or the existing tool-free no-progress guard.

## Prompt compatibility

Checklist updates persist non-model state and return new tool results; diagnostic reminders appear only in newly appended continuation prompts.
Neither feature rewrites earlier messages, leading system instructions, or active tool definitions.
The active Goal contract now teaches `goal_progress`; upgrading from an older contract intentionally appends a superseding contract once, while subsequent ordinary requests retain their prefix.
