---
"@narumitw/pi-plan-mode": major
---

Split draft updates from completion. Replace `plan_mode_complete({ plan })` with `plan_mode_update({ plan })` to store or replace the branch draft, then call `plan_mode_complete({})` alone to mark it ready. New `<proposed_plan>` blocks no longer complete a plan.

Read the draft as soon as it is stored in the fullscreen Plan pane or with `/plan show`. Updating does not write a project file or enable save, export, or implementation. Historical completion records and saved plans remain readable, and restoring an older in-progress workflow appends the new versioned instructions without rewriting history.
