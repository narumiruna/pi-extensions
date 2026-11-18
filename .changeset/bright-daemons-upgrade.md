---
"@narumitw/pi-sync-daemon": minor
"@narumitw/pi-sync": patch
---

Replace an older, reachable Pi Sync daemon on the first active connection after an upgrade. Wait for the old daemon to stop and exit before starting the new build. Passive and shutdown paths do not start a replacement.
