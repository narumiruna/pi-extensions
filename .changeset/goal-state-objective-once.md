---
"@narumitw/pi-goal": patch
---

Omit the objective from Goal accounting checkpoints when the session branch already stores it unchanged, so a long objective no longer grows the session file by its full length on every checkpoint.
