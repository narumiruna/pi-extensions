---
"@narumitw/pi-goal": patch
---

Keep one assistant-usage checkpoint per session so accounting after ordinary tool completions processes only new entries, with constant retained cache state. Recount safely on divergent branches and reloads without changing budget enforcement or goal-state snapshot frequency.
