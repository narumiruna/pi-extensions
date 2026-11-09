---
"@narumitw/pi-goal": patch
---

Cache cumulative assistant token usage by session and entry identity so accounting after tool completions processes only new entries instead of rescanning long branches. Preserve branch-local totals, reload behavior, budget enforcement, and goal-state snapshot frequency.
