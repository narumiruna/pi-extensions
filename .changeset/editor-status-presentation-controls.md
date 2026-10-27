---
"@narumitw/pi-tui-kit": minor
"@narumitw/pi-progress": minor
"@narumitw/pi-subagents": minor
"@narumitw/pi-herdr": patch
---

Add opt-in editor status presentation helpers for stable snapshot publication, session-local view controls, and bounded whole-snapshot collections. Keep the existing EditorStatusWidget API unchanged.

Retain visible Progress, Subagents, and Herdr widgets during updates. Add bounded summaries, manual view and item controls, and explicit one-shot compaction policies to Progress and Subagents without changing task state or persistent defaults. Preserve Progress completion retention and keep Herdr observation policies local.
