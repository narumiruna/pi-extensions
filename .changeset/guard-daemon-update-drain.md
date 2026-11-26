---
"@narumitw/pi-sync": patch
"@narumitw/pi-sync-daemon": patch
---

Defer daemon replacement while a sync review, transfer, or cleanup is active, and protect the open session file on the existing daemon. Start the new daemon's readiness deadline after it signals that it is booting. Use the intended daemon CLI to restart idle older owners that do not support the new guard. `/sync daemon status` now reports the running build and upgrade blockers without launching or replacing a daemon.
