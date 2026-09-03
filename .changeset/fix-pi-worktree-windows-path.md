---
"@narumitw/pi-worktree": patch
---

Normalize the cwd comparison in `writeTargetSession` so `/worktree` workspace switching works on Windows, where Git reports forward-slash paths but session headers store backslashes.
