---
"@narumitw/pi-plan-mode": patch
---

Skip unchanged branch-local state writes so an idle instance does not append a stale state branch during shutdown. Preserve meaningful state changes and completion recovery, and make repeated shutdown share one cleanup task.
